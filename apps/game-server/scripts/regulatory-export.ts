/**
 * Export réglementaire signé, en ligne de commande.
 *
 *   DATABASE_URL=… EXPORT_SIGNING_KEY="$(cat ed25519.pem)" \
 *     npm run export:regulatory -- --from 2026-10-01 --to 2026-11-01 --out ./exports/2026-10 --by agent-42
 *
 *   Vérification seule (côté auditeur, sans base) :
 *     npm run export:regulatory -- --verify ./exports/2026-10 [--fingerprint <sha256>]
 *
 * Clé : openssl genpkey -algorithm ed25519 -out ed25519.pem
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { RegulatoryExporter, verifyExport, writeExportDir, type Manifest } from "../src/audit/regulatoryExport.js";

const { values } = parseArgs({
  options: {
    from: { type: "string" }, to: { type: "string" }, out: { type: "string" }, by: { type: "string", default: "cli" },
    verify: { type: "string" }, fingerprint: { type: "string" },
  },
});

if (values.verify) {
  const dir = values.verify;
  const manifestJson = await readFile(join(dir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestJson) as Manifest;
  const files: Record<string, string> = {};
  for (const f of manifest.files) files[f.name] = await readFile(join(dir, f.name), "utf8");
  const r = verifyExport({
    manifestJson, files,
    signatureB64: (await readFile(join(dir, "manifest.sig"), "utf8")).trim(),
    publicKeyPem: await readFile(join(dir, "public_key.pem"), "utf8"),
  }, values.fingerprint);
  console.log(r.ok ? `✅ export ${manifest.exportId} intègre (${manifest.files.length} fichiers, clé ${manifest.signature.keyFingerprint.slice(0, 16)}…)` : `❌ ${r.errors.join("\n❌ ")}`);
  process.exit(r.ok ? 0 : 1);
}

if (!values.from || !values.to || !values.out) {
  console.error("usage : --from AAAA-MM-JJ --to AAAA-MM-JJ --out <répertoire> [--by <agent>]  |  --verify <répertoire>");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const ex = new RegulatoryExporter(pool, undefined, {
    signingKeyPem: (process.env.EXPORT_SIGNING_KEY ?? "").replace(/\\n/g, "\n"),
    production: process.env.NODE_ENV === "production",
  });
  const b = await ex.generate(new Date(values.from), new Date(values.to), values.by!);
  await writeExportDir(b, values.out);
  console.log(`✅ export ${b.manifest.exportId} → ${values.out}`);
  console.table(b.manifest.totals);
  console.log(`clé ${b.manifest.signature.keyFingerprint}${b.manifest.signature.ephemeralKey ? " (ÉPHÉMÈRE — dev uniquement)" : ""}`);
} finally {
  await pool.end();
}
