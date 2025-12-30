export const runtime = "nodejs";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*", // tighten later (itch domain) if you want
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function json(data: any, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

function edgegapHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `token ${process.env.EDGEGAP_TOKEN}`,
  };
}

function getState(st: any) {
  return (
    st?.current_status ||
    st?.data?.current_status ||
    st?.status ||
    st?.data?.status ||
    "UNKNOWN"
  );
}

function extractConn(st: any) {
  const fqdn =
    st?.fqdn ||
    st?.data?.fqdn ||
    st?.deployment?.fqdn ||
    st?.data?.deployment?.fqdn;

  const ports =
    st?.ports ||
    st?.data?.ports ||
    st?.deployment?.ports ||
    st?.data?.deployment?.ports;

  // Your Edgegap UI shows the port name as "gameport".
  const portName = process.env.EDGEGAP_PORT_NAME || "gameport";
  let external = 0;

  if (Array.isArray(ports) && ports.length) {
    const byName = ports.find(
      (p: any) => p?.name === portName || p?.port_name === portName
    );
    external = (byName?.external || ports[0]?.external || 0) as number;
  } else if (ports && typeof ports === "object") {
    external =
      ports?.[portName]?.external || ports?.external || (0 as number);
  }

  if (!fqdn || !external) return null;
  return { host: String(fqdn), port: Number(external) };
}

async function getStatusForRequestId(requestId: string) {
  const stRes = await fetch(`https://api.edgegap.com/v1/status/${requestId}`, {
    method: "GET",
    headers: edgegapHeaders(),
  });
  if (!stRes.ok) return null;

  const st = await stRes.json().catch(() => null);
  if (!st) return null;

  const conn = extractConn(st);
  return { status: getState(st), ...(conn ? conn : {}) };
}

async function findAnyActiveDeploymentRequestId(): Promise<string | null> {
  const res = await fetch("https://api.edgegap.com/v1/deployments", {
    method: "GET",
    headers: edgegapHeaders(),
  });

  if (!res.ok) return null;

  const json = await res.json().catch(() => null);
  if (!json) return null;

  const list: any[] =
    json.data ||
    json.deployments ||
    json.items ||
    json.results ||
    (Array.isArray(json) ? json : null);

  if (!Array.isArray(list) || list.length === 0) return null;

  for (const d of list) {
    const rid =
      d?.request_id ||
      d?.id ||
      d?.deployment_id ||
      d?.data?.request_id ||
      d?.deployment?.request_id;

    if (!rid) continue;

    const status =
      d?.current_status ||
      d?.status ||
      d?.state ||
      d?.deployment_status ||
      "";

    if (
      typeof status === "string" &&
      status.toUpperCase().includes("TERMINATED")
    )
      continue;

    return String(rid);
  }

  const first = list.find((d) => d?.request_id || d?.id || d?.deployment_id);
  return first ? String(first.request_id || first.id || first.deployment_id) : null;
}

export async function POST(req: Request) {
  try {
    const app = process.env.EDGEGAP_APP;
    const ver = process.env.EDGEGAP_VER;

    if (!process.env.EDGEGAP_TOKEN || !app || !ver) {
      return json(
        { error: "Missing EDGEGAP_TOKEN/EDGEGAP_APP/EDGEGAP_VER env vars" },
        { status: 500 }
      );
    }

    // 1) Reuse existing deployment if any (free plan safe)
    const existingRid = await findAnyActiveDeploymentRequestId();
    if (existingRid) {
      const info = await getStatusForRequestId(existingRid);
      return json(
        {
          reused: true,
          request_id: existingRid,
          status: info?.status ?? "UNKNOWN",
          ...(info?.host && info?.port ? { host: info.host, port: info.port } : {}),
        },
        { status: 200 }
      );
    }

    // 2) None exists -> create
    const tag = process.env.EDGEGAP_TAG || "boxer-free-singleton";

    const body = await req.json().catch(() => ({} as any));
    const userIp =
      body?.ip ||
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      null;

    const deployBody: any = {
      application: app,
      version: ver,
      tags: [tag],
    };

    if (userIp) {
      deployBody.users = [
        { user_type: "ip_address", user_data: { ip_address: userIp } },
      ];
    }

    const depRes = await fetch("https://api.edgegap.com/v2/deployments", {
      method: "POST",
      headers: edgegapHeaders(),
      body: JSON.stringify(deployBody),
    });

    const text = await depRes.text();

    // 3) Race safety: if deploy got blocked (free-plan limit), reuse again
    if (!depRes.ok) {
      if (depRes.status === 403) {
        const rid2 = await findAnyActiveDeploymentRequestId();
        if (rid2) {
          const info2 = await getStatusForRequestId(rid2);
          return json(
            {
              reused: true,
              request_id: rid2,
              status: info2?.status ?? "UNKNOWN",
              ...(info2?.host && info2?.port ? { host: info2.host, port: info2.port } : {}),
            },
            { status: 200 }
          );
        }
      }

      return json(
        { error: `Deploy failed ${depRes.status}: ${text}` },
        { status: 500 }
      );
    }

    const parsed = JSON.parse(text);
    const requestId =
      parsed.request_id || parsed.id || parsed.data?.request_id || null;

    if (!requestId) {
      return json({ error: "Deploy response missing request_id" }, { status: 500 });
    }

    return json(
      {
        reused: false,
        request_id: String(requestId),
        status: "DEPLOYING",
      },
      { status: 200 }
    );
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, { status: 500 });
  }
}
