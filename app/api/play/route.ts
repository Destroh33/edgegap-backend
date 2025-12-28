export const runtime = "nodejs";

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

  const portName = process.env.EDGEGAP_PORT_NAME || "game";
  let external = 0;

  if (Array.isArray(ports) && ports.length) {
    external = ports[0]?.external || 0;
  } else if (ports && typeof ports === "object") {
    external = ports?.[portName]?.external || ports?.external || 0;
  }

  if (!fqdn || !external) return null;
  return { host: String(fqdn), port: Number(external) };
}

// Try to find an existing active deployment by tag.
// This avoids Edgegap free-plan "only 1 active deployment" errors.
async function findExistingDeploymentRequestId(tag: string): Promise<string | null> {
  // Edgegap v2 deployments list endpoint.
  // If Edgegap changes schema, we fall back gracefully.
  const url = `https://api.edgegap.com/v2/deployments?tags=${encodeURIComponent(tag)}`;

  const res = await fetch(url, { headers: edgegapHeaders() });
  if (!res.ok) return null;

  const json = await res.json().catch(() => null);
  if (!json) return null;

  // Common shapes:
  // - { data: [ { request_id, status } ... ] }
  // - { deployments: [ ... ] }
  const list: any[] =
    json.data ||
    json.deployments ||
    json.items ||
    (Array.isArray(json) ? json : null);

  if (!Array.isArray(list) || list.length === 0) return null;

  // Pick the most recent-ish one:
  const first = list[0];
  const rid = first?.request_id || first?.id || first?.data?.request_id;
  return rid ? String(rid) : null;
}

export async function POST(req: Request) {
  try {
    const app = process.env.EDGEGAP_APP;
    const ver = process.env.EDGEGAP_VER;
    const tag = process.env.EDGEGAP_TAG || "boxer-free-singleton";

    if (!process.env.EDGEGAP_TOKEN || !app || !ver) {
      return Response.json(
        { error: "Missing EDGEGAP_TOKEN/EDGEGAP_APP/EDGEGAP_VER env vars" },
        { status: 500 }
      );
    }

    // 1) Always try reuse first (serverless safe).
    const existing = await findExistingDeploymentRequestId(tag);
    if (existing) {
      // Ask status to see if it's ready and to provide host/port if possible.
      const stRes = await fetch(`https://api.edgegap.com/v1/status/${existing}`, {
        headers: edgegapHeaders(),
      });

      if (stRes.ok) {
        const st = await stRes.json();
        const conn = extractConn(st);

        return Response.json({
          reused: true,
          request_id: existing,
          status: getState(st),
          ...(conn ? conn : {}),
        });
      }

      // If status fails, still return request_id so client can try polling.
      return Response.json({
        reused: true,
        request_id: existing,
        status: "UNKNOWN",
      });
    }

    // 2) No existing deployment found -> create new deployment.
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
    if (!depRes.ok) {
      return Response.json(
        { error: `Deploy failed ${depRes.status}: ${text}` },
        { status: 500 }
      );
    }

    const json = JSON.parse(text);
    const requestId =
      json.request_id || json.id || json.data?.request_id || null;

    if (!requestId) {
      return Response.json(
        { error: "Deploy response missing request_id" },
        { status: 500 }
      );
    }

    return Response.json({
      reused: false,
      request_id: String(requestId),
      status: "DEPLOYING",
    });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
