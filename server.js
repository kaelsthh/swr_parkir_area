// Relay Saweria -> Roblox (Open Cloud Messaging Service)
// Saweria webhook (POST + header Saweria-Callback-Signature) -> publish ke topic -> SaweriaHandler di game.
const express = require("express");
const { createMiddleware } = require("saweria-webhook-express");

const {
  STREAM_KEY,
  ROBLOX_API_KEY,
  UNIVERSE_ID,
  PLACE_ID,
  TOPIC = "SaweriaDonation_v1",
  TEST_TOKEN,
  PORT = 8080,
} = process.env;

const missingEnv = [
  !STREAM_KEY && "STREAM_KEY",
  !ROBLOX_API_KEY && "ROBLOX_API_KEY",
  !UNIVERSE_ID && !PLACE_ID && "UNIVERSE_ID atau PLACE_ID",
].filter(Boolean);
if (missingEnv.length) {
  console.error("Environment variable belum diisi:", missingEnv.join(", "));
}

let universeId = UNIVERSE_ID || null;

async function resolveUniverseId() {
  if (universeId) return universeId;
  const res = await fetch(`https://apis.roblox.com/universes/v1/places/${PLACE_ID}/universe`);
  if (!res.ok) throw new Error(`Gagal mencari universe id (HTTP ${res.status}); isi UNIVERSE_ID manual`);
  universeId = String((await res.json()).universeId);
  console.log("Universe id:", universeId);
  return universeId;
}

// Pesan Open Cloud maksimal ~1 KB, jadi teks dipotong.
const cut = (value, max) => Array.from(String(value ?? "")).slice(0, max).join("");

async function publish(topic, payload) {
  const id = await resolveUniverseId();
  const res = await fetch(`https://apis.roblox.com/messaging-service/v1/universes/${id}/topics/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: { "x-api-key": ROBLOX_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ message: JSON.stringify(payload) }),
  });
  if (!res.ok) throw new Error(`Publish gagal: HTTP ${res.status} ${await res.text()}`);
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.send(missingEnv.length ? `Env belum diisi: ${missingEnv.join(", ")}` : "ok"));

// URL ini dipasang di Saweria: https://<domain-kamu>/saweria
const verifySaweria = STREAM_KEY ? createMiddleware(STREAM_KEY) : (_req, res) => res.status(500).send("STREAM_KEY belum diisi");

app.post("/saweria", verifySaweria, async (req, res) => {
  if (!ROBLOX_API_KEY || (!UNIVERSE_ID && !PLACE_ID)) return res.status(500).send("ROBLOX_API_KEY / PLACE_ID belum diisi");
  const d = req.body || {};
  if (d.type && d.type !== "donation") return res.sendStatus(200);

  const payload = {
    id: String(d.id),
    name: cut(d.donator_name, 40),
    idr: Number(d.amount_raw),
    text: cut(d.message, 120),
    createdAt: d.created_at,
  };
  console.log("Donasi Saweria:", payload.id, payload.name, payload.idr);

  // Publish dulu baru balas: di serverless (Vercel) proses bisa dihentikan setelah respons.
  // Kalau gagal balas 502 supaya Saweria bisa kirim ulang (game membuang id yang sama).
  try {
    await publish(TOPIC, payload);
    res.sendStatus(200);
  } catch (err) {
    console.error(err.message);
    res.sendStatus(502);
  }
});

// Tes ujung-ke-ujung: POST /test  header x-test-token, body {"name":"Budi","idr":10000,"text":"halo","studio":true}
// studio:true -> publish ke "<TOPIC>_Studio" (didengarkan Roblox Studio, bukan server live)
if (TEST_TOKEN) {
  app.post("/test", async (req, res) => {
    if (req.get("x-test-token") !== TEST_TOKEN) return res.sendStatus(401);
    const b = req.body || {};
    const payload = {
      id: `test-${Date.now()}`,
      name: cut(b.name || "Tester", 40),
      idr: Number(b.idr) || 10000,
      text: cut(b.text || "", 120),
      createdAt: new Date().toISOString(),
    };
    try {
      await publish(b.studio ? `${TOPIC}_Studio` : TOPIC, payload);
      res.json({ ok: true, payload });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });
}

module.exports = app; // Vercel memakai export ini

if (require.main === module) {
  app.listen(PORT, () => console.log("Saweria relay jalan di port", PORT));
}
