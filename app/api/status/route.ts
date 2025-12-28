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

export async function GET(req: Request) {
  try {
    if (!process.env.EDGEGAP_TOKEN) {
      return Response.json(
        { error: "Missing EDGEGAP_TOKEN env var" },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(req.url);
    const requestId = searchParams.get("request_id");
    if (!requestId) {
      return Response.json({ error: "Missing request_id" }, { status: 400 });
    }

    const stRes = await fetch(`https://api.edgegap.com/v1/status/${requestId}`, {
      method: "GET",
      headers: edgegapHeaders(),
    });

    const text = await stRes.text();
    if (!stRes.ok) {
      return Response.json(
        { error: `Status failed ${stRes.status}: ${text}` },
        { status: 500 }
      );
    }

    const st = JSON.parse(text);
    const status = getState(st);
    const conn = extractConn(st);

    return Response.json({
      request_id: requestId,
      status,
      ...(conn ? conn : {}),
    });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
