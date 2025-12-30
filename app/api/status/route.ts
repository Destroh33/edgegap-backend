export const runtime = "nodejs";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
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

export async function GET(req: Request) {
  try {
    if (!process.env.EDGEGAP_TOKEN) {
      return json({ error: "Missing EDGEGAP_TOKEN env var" }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const requestId = searchParams.get("request_id");
    if (!requestId) {
      return json({ error: "Missing request_id" }, { status: 400 });
    }

    const stRes = await fetch(`https://api.edgegap.com/v1/status/${requestId}`, {
      method: "GET",
      headers: edgegapHeaders(),
    });

    const text = await stRes.text();
    if (!stRes.ok) {
      return json(
        { error: `Status failed ${stRes.status}: ${text}` },
        { status: 500 }
      );
    }

    const st = JSON.parse(text);
    const status = getState(st);
    const conn = extractConn(st);

    return json(
      {
        request_id: requestId,
        status,
        ...(conn ? conn : {}),
      },
      { status: 200 }
    );
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, { status: 500 });
  }
}
