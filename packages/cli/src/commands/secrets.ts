import { loadFromVault, saveToVault, TpsVault } from "../utils/identity.js";

interface SecretsArgs {
  action: "set" | "list" | "remove";
  key?: string;
  value?: string;
  json?: boolean;
}

export async function runSecrets(args: SecretsArgs): Promise<void> {
  const vault = await loadFromVault();
  if (!vault) {
    console.error("No vault found. Run `tps identity init` first.");
    process.exit(1);
  }

  switch (args.action) {
    case "set": {
      if (!args.key || args.value === undefined) {
        console.error("Usage: tps secrets set <KEY>=<VALUE>");
        process.exit(1);
      }
      vault.secrets[args.key] = args.value;
      await saveToVault(vault);
      console.log(`Secret '${args.key}' updated.`);
      break;
    }

    case "list": {
      const keys = Object.keys(vault.secrets);
      if (args.json) {
        console.log(JSON.stringify(keys, null, 2));
      } else {
        if (keys.length === 0) {
          console.log("No secrets stored.");
        } else {
          console.log("Stored secrets:");
          for (const key of keys) {
            console.log(`  ${key}`);
          }
        }
      }
      break;
    }

    case "remove": {
      if (!args.key) {
        console.error("Usage: tps secrets remove <KEY>");
        process.exit(1);
      }
      if (vault.secrets[args.key]) {
        delete vault.secrets[args.key];
        await saveToVault(vault);
        console.log(`Secret '${args.key}' removed.`);
      } else {
        console.log(`Secret '${args.key}' not found.`);
      }
      break;
    }
  }
}
