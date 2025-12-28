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
    // common shapes:
    // ports: { game: { external: 12345 } }
    // ports: { external: 12345 }
    external = ports?.[portName]?.external || ports?.external || 0;
  }

  if (!fqdn || !external) return null;
  return { host: String(fqdn), port: Number(external) };
}

// -----------------------------
// Find existing active deployment (free plan -> max 1 active)
// -----------------------------
async function findAnyActiveDeploymentRequestId(): Promise<string | null> {
  const res = await fetch("https://api.edgegap.com/v2/deployments", {
    method: "GET",
    headers: edgegapHeaders(),
  });

  if (!res.ok) return null;

  const json = await res.json().catch(() => null);
  if (!json) return null;

  // Try a bunch of common shapes safely.
  const list: any[] =
    json.data ||
    json.deployments ||
    json.items ||
    json.results ||
    (Array.isArray(json) ? json : null);

  if (!Array.isArray(list) || list.length === 0) return null;

  // Free plan => there should be only one active anyway.
  const d = list[0];

  const rid =
    d?.request_id ||
    d?.id ||
    d?.data?.request_id ||
    d?.deployment?.request_id ||
    d?.deployment_id;

  return rid ? String(rid) : null;
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
  return {
    status: getState(st),
    ...(conn ? conn : {}),
  };
}

export async function POST(req: Request) {
  try {
    const app = process.env.EDGEGAP_APP;
    const ver = process.env.EDGEGAP_VER;

    if (!process.env.EDGEGAP_TOKEN || !app || !ver) {
      return Response.json(
        { error: "Missing EDGEGAP_TOKEN/EDGEGAP_APP/EDGEGAP_VER env vars" },
        { status: 500 }
      );
    }

    // 1) ALWAYS try to reuse any existing active deployment first.
    // This prevents the free-plan 403 limit error.
    const existingRid = await findAnyActiveDeploymentRequestId();
    if (existingRid) {
      const info = await getStatusForRequestId(existingRid);
      return Response.json({
        reused: true,
        request_id: existingRid,
        status: info?.status ?? "UNKNOWN",
        ...(info?.host && info?.port ? { host: info.host, port: info.port } : {}),
      });
    }

    // 2) None exists -> create a new deployment.
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

    // If we race (two clients click at once), Edgegap may return the 403 limit.
    // In that case, immediately reuse the now-existing deployment.
    if (!depRes.ok) {
      if (depRes.status === 403) {
        const rid2 = await findAnyActiveDeploymentRequestId();
        if (rid2) {
          const info2 = await getStatusForRequestId(rid2);
          return Response.json({
            reused: true,
            request_id: rid2,
            status: info2?.status ?? "UNKNOWN",
            ...(info2?.host && info2?.port ? { host: info2.host, port: info2.port } : {}),
          });
        }
      }

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
