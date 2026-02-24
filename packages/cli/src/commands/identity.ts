/**
 * TPS Identity CLI — manage host identity and branch key registry.
 */
import {
  initHostIdentity,
  loadHostIdentity,
  generateKeyPair,
  registerBranch,
  lookupBranch,
  revokeBranch,
  listBranches,
  isExpired,
  isRevoked,
  checkKeyPermissions,
  saveKeyPair,
} from "../utils/identity.js";
import { installNonoProfiles } from "../utils/nono.js";
import { join } from "node:path";
import { homedir } from "node:os";

interface IdentityArgs {
  action: "init" | "show" | "register" | "list" | "revoke" | "verify";
  branch?: string;
  reason?: string;
  json?: boolean;
  expiresIn?: string; // e.g. "90d", "30d"
  trust?: "high" | "standard" | "low";
  pubkey?: string;     // hex-encoded signing public key (for register)
  encPubkey?: string;  // hex-encoded encryption public key (for register)
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)([dhm])$/);
  if (!m) throw new Error(`Invalid duration: ${s}. Use e.g. 90d, 24h, 60m`);
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case "d":
      return n * 86400000;
    case "h":
      return n * 3600000;
    case "m":
      return n * 60000;
    default:
      throw new Error(`Unknown unit: ${m[2]}`);
  }
}

export async function runIdentity(args: IdentityArgs): Promise<void> {
  switch (args.action) {
    case "init": {
      const expiresIn = args.expiresIn ? parseDuration(args.expiresIn) : undefined;
      const kp = await initHostIdentity({ expiresIn });
      installNonoProfiles(undefined, args.json);
      const sigPubHex = Buffer.from(kp.signing.publicKey).toString("hex");
      const encPubHex = Buffer.from(kp.encryption.publicKey).toString("hex");
      if (args.json) {
        console.log(
          JSON.stringify(
            {
              fingerprint: kp.fingerprint,
              signingPublicKey: sigPubHex,
              encryptionPublicKey: encPubHex,
              createdAt: kp.createdAt,
              expiresAt: kp.expiresAt || null,
            },
            null,
            2
          )
        );
      } else {
        console.log(`Identity initialized.`);
        console.log(`  Fingerprint:     ${kp.fingerprint}`);
        console.log(`  Signing pubkey:  ${sigPubHex}`);
        console.log(`  Encrypt pubkey:  ${encPubHex}`);
        console.log(`  Created:         ${kp.createdAt}`);
        if (kp.expiresAt) console.log(`  Expires:         ${kp.expiresAt}`);
        console.log(`\nTo register this identity on a host:\n  tps identity register <name> --pubkey ${sigPubHex} --enc-pubkey ${encPubHex}`);
      }
      return;
    }

    case "show": {
      let kp;
      try {
        kp = await loadHostIdentity();
      } catch {
        console.error(
          "No host identity found. Run: tps identity init"
        );
        process.exit(1);
      }

      const identityDir =
        process.env.TPS_IDENTITY_DIR ||
        join(process.env.HOME || homedir(), ".tps", "identity");
      const vaultPath = join(identityDir, "vault.json");
      const permOk = checkKeyPermissions(vaultPath);

      if (args.json) {
        console.log(
          JSON.stringify(
            {
              fingerprint: kp.fingerprint,
              createdAt: kp.createdAt,
              expiresAt: kp.expiresAt || null,
              expired: kp.expiresAt
                ? new Date(kp.expiresAt) < new Date()
                : false,
              keyPermissionsOk: permOk,
            },
            null,
            2
          )
        );
      } else {
        console.log(`Host Identity`);
        console.log(`  Fingerprint: ${kp.fingerprint}`);
        console.log(`  Created:     ${kp.createdAt}`);
        if (kp.expiresAt) {
          const expired = new Date(kp.expiresAt) < new Date();
          console.log(
            `  Expires:     ${kp.expiresAt}${expired ? " ⚠️  EXPIRED" : ""}`
          );
        }
        console.log(
          `  Vault perms: ${permOk ? "✅ secure (0600)" : "⚠️  insecure — run chmod 600 on vault.json"}`
        );
      }
      return;
    }

    case "register": {
      if (!args.branch || !args.pubkey) {
        console.error(
          "Usage: tps identity register <branch-id> --pubkey <hex>\n" +
          "\nThe branch generates its own keys (tps identity init on the branch).\n" +
          "Only the PUBLIC key is registered here. The host never sees the private key.\n" +
          "\nOptional: --enc-pubkey <hex>  X25519 encryption public key"
        );
        process.exit(1);
      }

      // Parse hex-encoded public keys from branch
      const signingPubKey = new Uint8Array(
        (args.pubkey.match(/.{2}/g) || []).map((b) => parseInt(b, 16))
      );
      if (signingPubKey.length !== 32) {
        console.error("Signing public key must be 32 bytes (64 hex chars).");
        process.exit(1);
      }

      let encPubKey: Uint8Array | undefined;
      if (args.encPubkey) {
        encPubKey = new Uint8Array(
          (args.encPubkey.match(/.{2}/g) || []).map((b) => parseInt(b, 16))
        );
        if (encPubKey.length !== 32) {
          console.error("Encryption public key must be 32 bytes (64 hex chars).");
          process.exit(1);
        }
      }

      const expiresIn = args.expiresIn
        ? parseDuration(args.expiresIn)
        : 90 * 86400000;
      const expiresAt = new Date(Date.now() + expiresIn).toISOString();

      const registered = registerBranch(
        args.branch,
        signingPubKey,
        {
          createdAt: new Date().toISOString(),
          expiresAt,
          trust: args.trust || "standard",
        },
        encPubKey
      );

      if (args.json) {
        console.log(
          JSON.stringify(
            {
              branchId: args.branch,
              fingerprint: registered.meta.fingerprint,
              createdAt: registered.meta.createdAt,
              expiresAt: registered.meta.expiresAt || null,
              trust: registered.meta.trust,
              hasEncryptionKey: !!encPubKey,
            },
            null,
            2
          )
        );
      } else {
        console.log(`Registered branch: ${args.branch}`);
        console.log(`  Fingerprint:  ${registered.meta.fingerprint}`);
        console.log(`  Trust:        ${registered.meta.trust}`);
        console.log(`  Expires:      ${registered.meta.expiresAt}`);
        console.log(`  Encryption:   ${encPubKey ? "✅ X25519 key registered" : "⚠️  no encryption key (provide --enc-pubkey)"}`);
      }
      return;
    }

    case "list": {
      const branches = listBranches();
      if (args.json) {
        console.log(
          JSON.stringify(
            branches.map((b) => ({
              branchId: b.branchId,
              fingerprint: b.meta.fingerprint,
              createdAt: b.meta.createdAt,
              expiresAt: b.meta.expiresAt || null,
              trust: b.meta.trust || "standard",
              expired: isExpired(b.meta),
            })),
            null,
            2
          )
        );
      } else if (branches.length === 0) {
        console.log("No branches registered.");
      } else {
        console.log("Registered branches:");
        for (const b of branches) {
          const expired = isExpired(b.meta) ? " ⚠️ EXPIRED" : "";
          console.log(
            `  ${b.branchId} [${b.meta.trust || "standard"}] ${b.meta.fingerprint.slice(0, 16)}...${expired}`
          );
        }
      }
      return;
    }

    case "revoke": {
      if (!args.branch) {
        console.error("Usage: tps identity revoke <branch-id> --reason \"...\"");
        process.exit(1);
      }
      const reason = args.reason || "manual revocation";
      try {
        revokeBranch(args.branch, reason);
        console.log(`Revoked branch: ${args.branch}`);
        console.log(`  Reason: ${reason}`);
        console.log(
          `  The branch can no longer authenticate. Re-provision to restore.`
        );
      } catch (e: any) {
        console.error(e.message);
        process.exit(1);
      }
      return;
    }

    case "verify": {
      if (!args.branch) {
        console.error("Usage: tps identity verify <branch-id>");
        process.exit(1);
      }

      if (isRevoked(args.branch)) {
        if (args.json) {
          console.log(JSON.stringify({ branchId: args.branch, valid: false, reason: "revoked" }));
        } else {
          console.log(`❌ ${args.branch}: REVOKED`);
        }
        process.exit(1);
      }

      const entry = lookupBranch(args.branch);
      if (!entry) {
        if (args.json) {
          console.log(JSON.stringify({ branchId: args.branch, valid: false, reason: "not found" }));
        } else {
          console.log(`❌ ${args.branch}: not registered`);
        }
        process.exit(1);
      }

      const expired = isExpired(entry.meta);
      if (args.json) {
        console.log(
          JSON.stringify({
            branchId: args.branch,
            valid: !expired,
            fingerprint: entry.meta.fingerprint,
            expiresAt: entry.meta.expiresAt || null,
            expired,
          }, null, 2)
        );
      } else {
        if (expired) {
          console.log(`⚠️  ${args.branch}: EXPIRED (${entry.meta.expiresAt})`);
          process.exit(1);
        } else {
          console.log(`✅ ${args.branch}: valid`);
          console.log(`  Fingerprint: ${entry.meta.fingerprint}`);
          if (entry.meta.expiresAt)
            console.log(`  Expires:     ${entry.meta.expiresAt}`);
        }
      }
      return;
    }
  }
}
