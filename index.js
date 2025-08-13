// index.js
import express from "express";
import axios from "axios";
import { parseStringPromise } from "xml2js";

const app = express();
app.use(express.json());

function isValidAfm(afm) {
  if (!/^\d{9}$/.test(afm)) return false;
  const digits = afm.split('').map(Number);
  const check = digits[8];
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += digits[i] * (2 ** (8 - i));
  }
  const mod = (sum % 11) % 10;
  return mod === check;
}

app.post("/validate-afm", async (req, res) => {
  const { afm } = req.body;
  if (!afm) return res.status(400).json({ valid: false, error: "Missing AFM" });

  // 1) Τοπικός έλεγχος
  if (!isValidAfm(afm)) {
    return res.json({ valid: false, error: "INVALID_CHECKSUM" });
  }

  // 2) Κλήση ΑΑΔΕ SOAP
  const AADE_URL = "https://www1.gsis.gr/wsaade/RgWsPublic2/RgWsPublic2";
  const USER = process.env.AADE_USERNAME;
  const PASS = process.env.AADE_PASSWORD;

  const soapEnvelope = `
  <env:Envelope
    xmlns:env="http://www.w3.org/2003/05/soap-envelope"
    xmlns:ns1="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
    xmlns:ns2="http://rgwspublic2/RgWsPublic2Service"
    xmlns:ns3="http://rgwspublic2/RgWsPublic2">
    <env:Header>
      <ns1:Security>
        <ns1:UsernameToken>
          <ns1:Username>${USER}</ns1:Username>
          <ns1:Password>${PASS}</ns1:Password>
        </ns1:UsernameToken>
      </ns1:Security>
    </env:Header>
    <env:Body>
      <ns2:rgWsPublic2AfmMethod>
        <ns2:INPUT_REC>
          <ns3:afm_called_by/>
          <ns3:afm_called_for>${afm}</ns3:afm_called_for>
        </ns2:INPUT_REC>
      </ns2:rgWsPublic2AfmMethod>
    </env:Body>
  </env:Envelope>`;

  try {
    const { data: xml } = await axios.post(AADE_URL, soapEnvelope, {
      headers: { "Content-Type": "application/soap+xml; charset=utf-8" }
    });

    const parsed = await parseStringPromise(xml, { explicitArray: false });
    const out = parsed?.["env:Envelope"]?.["env:Body"]?.["ns2:rgWsPublic2AfmMethodResponse"]?.OUTPUT_REC
             || parsed?.Envelope?.Body?.rgWsPublic2AfmMethodResponse?.OUTPUT_REC;

    const name = out?.ns3__onomasia || out?.onomasia || null;
    const doy  = out?.ns3__doy_descr || out?.doy_descr || null;

    res.json({ valid: !!name, name, tax_office: doy });
  } catch (err) {
    res.json({ valid: false, error: "AADE_ERROR", detail: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("AFM Validator running");
});
