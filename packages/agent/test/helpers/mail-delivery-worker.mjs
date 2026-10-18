import { parentPort, workerData } from "node:worker_threads";
import * as ed from "@noble/ed25519";

const { MailClient } = await import(workerData.module);
const client = new MailClient(workerData.mailDir, undefined, workerData.agent, {
  async getAgent(name) {
    return name === workerData.from
      ? { publicKey: Buffer.from(ed.getPublicKey(Buffer.from(workerData.seed, "base64"))) }
      : null;
  },
});
const result = await client.deliverNext();
parentPort.once("message", async () => {
  parentPort.postMessage(result.status === "delivered" ? await client.completeDelivery(result.delivery) : result);
});
parentPort.postMessage(result);
