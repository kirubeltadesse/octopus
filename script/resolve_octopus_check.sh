#!/usr/bin/env bash
# Safely finalize one orphaned Octopus Review GitHub check.
# Dry run:  bash resolve_octopus_check.sh
# Apply:    bash resolve_octopus_check.sh --apply
set -euo pipefail

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--apply" ) ]]; then
  echo "Usage: bash resolve_octopus_check.sh [--apply]" >&2
  exit 2
fi

cd "$HOME/Tools/octopus" || { echo "Octopus checkout not found" >&2; exit 2; }
COMPOSE=(docker compose -f docker-compose.selfhost.yml -f docker-compose.arm64.yml)

# Execute in Octopus's web container so its existing encryption secrets never
# leave that container. DB fields are passed over stdin, not shell arguments.
NODE_CODE=$(cat <<'JS'
"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const target = {
  repo: "Swarmies/kickoff-backend",
  pr: 259,
  checkId: 130956925371,
  sha: "cbb57b11821b60f8be8dd9c67a3f754b65c03caf",
};

function appConfigFromStdin() {
  const row = fs.readFileSync(0, "utf8").trim();
  const fields = row.split("|");
  if (fields.length !== 2) throw new Error("Missing or malformed Octopus GitHub App config row");
  const [dbAppId, encryptedKey] = fields;
  const appId = dbAppId || process.env.GITHUB_APP_ID;
  if (!appId || !/^\d+$/.test(appId)) throw new Error("GitHub App ID not configured");

  let privateKey;
  if (encryptedKey) {
    const blob = Buffer.from(encryptedKey, "base64url");
    if (blob.length < 29) throw new Error("Encrypted GitHub App key is invalid");
    const keys = [];
    if (process.env.OCTOPUS_DATA_KEY) {
      const raw = process.env.OCTOPUS_DATA_KEY.trim();
      if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error("OCTOPUS_DATA_KEY format is invalid");
      keys.push(Buffer.from(raw, "hex"));
    }
    if (process.env.BETTER_AUTH_SECRET) {
      keys.push(crypto.createHash("sha256").update(process.env.BETTER_AUTH_SECRET).digest());
    }
    for (const key of keys) {
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(0,12));
        decipher.setAuthTag(blob.subarray(12,28));
        privateKey = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
        break;
      } catch { /* Try legacy key if necessary. */ }
    }
    if (!privateKey) throw new Error("Cannot decrypt stored App key; check Octopus encryption settings");
  } else {
    privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    if (!privateKey) throw new Error("No GitHub App private key found in database or web environment");
    if (!privateKey.includes("-----BEGIN")) privateKey = Buffer.from(privateKey,"base64").toString("utf8");
  }
  return { appId: Number(appId), privateKey };
}

function makeJwt(appId, privateKey) {
  const now = Math.floor(Date.now()/1000);
  const encode = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const input = `${encode({alg:"RS256",typ:"JWT"})}.${encode({iat:now-60,exp:now+540,iss:String(appId)})}`;
  const signature = crypto.createSign("RSA-SHA256").update(input).sign(privateKey,"base64url");
  return `${input}.${signature}`;
}

async function github(path, token, method="GET", body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "octopus-stuck-check-recovery",
      ...(body ? {"Content-Type":"application/json"} : {}),
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path} returned HTTP ${response.status}`);
  return response.json();
}

(async () => {
  const {appId,privateKey} = appConfigFromStdin();
  const appJwt = makeJwt(appId,privateKey);
  const repoPath = `/repos/${target.repo}`;
  const installation = await github(`${repoPath}/installation`,appJwt);
  if (Number(installation.app_id) !== appId) throw new Error("Repository installation is not the configured Octopus App");
  if (installation.permissions?.checks !== "write") throw new Error("Octopus GitHub App lacks Checks: write permission");
  const access = await github(`/app/installations/${installation.id}/access_tokens`, appJwt, "POST", {});
  const token = access.token;
  if (!token) throw new Error("GitHub did not return an installation token");
  const [pr,check] = await Promise.all([
    github(`${repoPath}/pulls/${target.pr}`,token),
    github(`${repoPath}/check-runs/${target.checkId}`,token),
  ]);
  if (pr.head?.sha !== target.sha) throw new Error("PR HEAD has changed: refusing to edit an old check");
  if (check.id !== target.checkId || check.name !== "Octopus Review") throw new Error("Unexpected GitHub check identity");
  if (check.head_sha !== target.sha) throw new Error("Check SHA does not match the verified PR HEAD");
  if (Number(check.app?.id) !== appId) throw new Error("Check is not owned by the configured Octopus GitHub App");
  console.log(`Verified: ${target.repo} PR #${target.pr}`);
  console.log(`Check ${check.id}: ${check.status}, conclusion=${check.conclusion ?? "null"}`);
  if (check.status === "completed") {
    console.log("Already completed; no change needed.");
    return;
  }
  if (check.status !== "in_progress") throw new Error("Check state is unexpected; refusing to modify it");
  if (process.env.OCTOPUS_REPAIR_APPLY !== "YES") {
    console.log("DRY RUN: No changes made. Re-run with --apply to finish this check as failure.");
    return;
  }
  const updated = await github(`${repoPath}/check-runs/${target.checkId}`, token, "PATCH", {
    status: "completed",
    conclusion: "failure",
    completed_at: new Date().toISOString(),
    output: {
      title: "Octopus Review publication failed",
      summary: "The AI assessment completed, but GitHub publication failed following a socket error. This abandoned check was finalized manually; the earlier successful review was preserved.",
    },
  });
  if (updated.status !== "completed" || updated.conclusion !== "failure") throw new Error("GitHub returned an unexpected check state");
  console.log(`SUCCESS: Check ${updated.id} is now completed with conclusion=failure.`);
})().catch(error => { console.error(`Repair stopped: ${error.message}`); process.exitCode=1; });
JS
)

# Only the App ID and encrypted private-key ciphertext leave Postgres;
# both are delivered on stdin to the web container for in-memory decryption.
# Use an explicit SQL literal for an empty string, no spaces in the delimiter.
PSQL_QUERY="SELECT COALESCE(\"githubAppId\", ''), COALESCE(\"githubAppPrivateKeyEnc\", '') FROM system_config WHERE id='singleton'"

if [[ ${1:-} == "--apply" ]]; then
  "${COMPOSE[@]}" exec -T postgres psql -U octopus -d octopus -X -qAt -F '|' -c "$PSQL_QUERY" \
    | "${COMPOSE[@]}" exec -T -e OCTOPUS_REPAIR_APPLY=YES web node -e "$NODE_CODE"
else
  "${COMPOSE[@]}" exec -T postgres psql -U octopus -d octopus -X -qAt -F '|' -c "$PSQL_QUERY" \
    | "${COMPOSE[@]}" exec -T web node -e "$NODE_CODE"
fi
