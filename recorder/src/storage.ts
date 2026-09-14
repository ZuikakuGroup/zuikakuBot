import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { RecorderConfig } from "./config.js";

export class RecordingStorage {
  private readonly client: S3Client;
  constructor(private readonly config: RecorderConfig["r2"]) {
    this.client = new S3Client({ endpoint: config.endpoint, region: "auto", credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  }
  async uploadWithRetry(path: string, fileName: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) try { return await this.upload(path, fileName); } catch (error) {
      lastError = error; if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
    }
    throw lastError;
  }
  private async upload(path: string, fileName: string): Promise<string> {
    const key = `recordings/${fileName}`; const file = await stat(path);
    await this.client.send(new PutObjectCommand({ Bucket: this.config.bucketName, Key: key, Body: createReadStream(path), ContentLength: file.size, ContentType: "audio/mpeg", ContentDisposition: "inline" }));
    return `${this.config.publicBaseUrl.replace(/\/$/, "")}/${key}`;
  }
}
