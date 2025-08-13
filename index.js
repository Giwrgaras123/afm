// index.js
import express from "express";
import axios from "axios";
import { parseStringPromise } from "xml2js";

const PORT = process.env.PORT || 3000;
const AADE_URL = "https://www1.gsis.gr/wsaade/RgWsPublic2/RgWsPublic2";
const AADE_USER = process.env.AADE_USERNAME;
const AADE_PASS = process.env.AADE_PASSWORD;
const DEBUG = (process.env.DEBUG || "false").toLowerCase() === "true";

if (!AADE_USER || !AADE_PASS) {
  console.warn("[WARN] Missing AADE_USERNAME / AADE_PASSWORD env vars.");
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- Helpers ---------------------------------------------------------------

function isValidAfmChecksum(afm) {
  if (!/^\d{9}$/.test(afm)) return false;
  const digits = afm.split("").map(Number);
  const check = digits[8];
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += digits[i] * (2 ** (8 - i));
  }
  const mod = (sum % 11) % 10;
  return mod === check;
}

function buildSoapEnvelope(afm) {
  return `
  <env:Envelope
    xmlns:env="http://www.w3.org/2003/05/soap-envelope"
    xmlns:ns1="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
    xmlns:srvc="http://rgwspublic2/RgWsPublic2Service"
    xmlns="http://rgwspublic2/RgWsPublic2">
    <env:Header>
      <ns1:Security>
        <ns1:UsernameToken>
          <ns1:Username>${AADE_USER}</ns1:Username>
          <ns1:Password>${AADE_PASS}</ns1:Password>
        </ns1:UsernameToken>
      </ns1:Security>
    </env:Header>
    <env:Body>
      <srvc:rgWsPublic2AfmMethod>
        <srvc:INPUT_REC>
          <afm_called_by/>
          <afm_called_for>${afm}</afm_called_for>
        </srvc:INPUT_REC>
      </srvc:rgWsPublic2AfmMethod>
    </env:Body>
  </env:Envelope>`.trim();
}

// Safely read xml2js nodes that may be { _: "text", $: { xsi:nil: "true" } }
function readNode(node) {
  if (node == null) return null;
  if (typeof node === "string") return node;
  if (typeof node._ === "string") return node._;
  return null;
}

async function callAADE(afm) {
  const envelope = buildSoapEnvelope(afm);

  const { data: xml } = await axios.post(AADE_URL, envelope, {
    headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
    timeout: 15000
  });

  if (DEBUG) console.log("[AADE RAW XML]\n", xml);

  // Parse with attributes + charkey to catch xsi:nil cases
  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    attrkey: "$",
    charkey: "_"
  });

  // Navigate to result record regardless of namespace prefixing
  const body = parsed?.["env:Envelope"]?.["env:Body"]
            || parsed?.Envelope?.Body;

  const resp = body?.["srvc:rgWsPublic2AfmMethodResponse"]
           || body?.rgWsPublic2AfmMethodResponse;

  const result = resp?.["srvc:result"] || resp?.result;
  const rec = result?.rg_ws_public2_result_rtType;

  const errorCode = readNode(rec?.error_rec?.error_code);
  const errorDescr = readNode(rec?.error_rec?.error_descr);

  const basic = rec?.basic_rec || {};
  const afmVal      = readNode(basic?.afm);
  const nameVal     = readNode(basic?.onomasia);
  const doy         = readNode(basic?.doy);
  const doyDescr    = readNode(basic?.doy_descr);
  const statusDescr = readNode(basic?.deactivation_flag_descr);

  const hasError = !!(errorCode && errorCode !== "");

  let valid = false;
  let status = "UNKNOWN";
  if (!hasError && afmVal && nameVal) {
    valid = true;
    status = statusDescr === "ΕΝΕΡΓΟΣ ΑΦΜ" ? "ACTIVE" : "INACTIVE";
  }

  return {
    valid,
    status,                  // ACTIVE / INACTIVE / UNKNOWN
    error_code: errorCode || null,
    error_descr: errorDescr || null,
    name: nameVal || null,
    afm: afmVal || null,
    tax_office_code: doy || null,
    tax_office: doyDescr || null
  };
}

// --- Routes ---------------------------------------------------------------

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Allow POST / to work (many Flows hit root by mistake)
app.post("/", (req, res) => {
  res.redirect(307, "/validate-afm");
});

// Minimal endpoint for Shopify Flow (plain "true"/"false")
app.post("/validate-afm", async (req, res) => {
  try {
    const afmRaw = String(req.body?.afm || "").trim();
    if (!afmRaw) {
      if (DEBUG) console.log("[REQ] Missing AFM:", req.body);
      return res.status(200).type("text/plain").send("false");
    }

    // 1) Checksum
    if (!isValidAfmChecksum(afmRaw)) {
      if (DEBUG) console.log("[CHECKSUM] Invalid AFM:", afmRaw);
      return res.status(200).type("text/plain").send("false");
    }

    // 2) AADE
    const result = await callAADE(afmRaw);
    if (DEBUG) console.log("[AADE RESULT]", result);

    return res.status(200).type("text/plain").send(result.valid ? "true" : "false");
  } catch (err) {
    console.error("[ERROR] /validate-afm", err?.message);
    return res.status(200).type("text/plain").send("false");
  }
});

// Rich JSON for debugging/observability
app.post("/validate-afm/full", async (req, res) => {
  try {
    const afmRaw = String(req.body?.afm || "").trim();
    const orderId = req.body?.order_id || null;

    const response = {
      order_id: orderId,
      afm: afmRaw,
      checksum_ok: isValidAfmChecksum(afmRaw)
    };

    if (!response.checksum_ok) {
      return res.json({ ...response, valid: false, error: "INVALID_CHECKSUM" });
    }

    const aade = await callAADE(afmRaw);
    return res.json({ ...response, ...aade });
  } catch (err) {
    console.error("[ERROR] /validate-afm/full", err?.message);
    return res.json({ valid: false, error: "AADE_ERROR", detail: err?.message || "Unknown" });
  }
});

app.listen(PORT, () => {
  console.log(`AFM Validator listening on :${PORT}`);
});
