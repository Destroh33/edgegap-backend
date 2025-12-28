export const runtime = "nodejs";

function edgegapHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `token ${process.env.EDGEGAP_TOKEN}`,
  };
}

let cachedRequestId: string | null = null;

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

    const body = await req.json().catch(() => ({} as any));
    const userIp =
      body?.ip ||
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      null;

    if (cachedRequestId) {
      const stRes = await fetch(
        `https://api.edgegap.com/v1/status/${cachedRequestId}`,
        { headers: edgegapHeaders() }
      );

      if (stRes.ok) {
        const st = await stRes.json();
        const conn = extractConn(st);
        if (conn) {
          return Response.json({
            reused: true,
            request_id: cachedRequestId,
            status: getState(st),
            ...conn,
          });
        }
      } else {
        cachedRequestId = null;
      }
    }

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
    cachedRequestId =
      json.request_id || json.id || json.data?.request_id || null;

    if (!cachedRequestId) {
      return Response.json(
        { error: "Deploy response missing request_id" },
        { status: 500 }
      );
    }

    return Response.json({
      reused: false,
      request_id: cachedRequestId,
      status: "DEPLOYING",
    });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
