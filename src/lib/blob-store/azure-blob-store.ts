import {
  BLOB_STORAGE,
  type AttachmentBlobStore,
} from "@/lib/blob-store/types";
import { loadCloudBlobConfig } from "@/lib/blob-store/config";
import {
  BLOB_CONFIG_ERROR,
  BLOB_CONTENT_TYPE,
} from "@/lib/blob-store/constants";
import { buildObjectKey, decodeObjectRef, encodeObjectRef } from "@/lib/blob-store/object-ref";
import { streamBodyToBuffer } from "@/lib/blob-store/stream";

let containerClientPromise: Promise<{
  getBlockBlobClient: (key: string) => {
    uploadData: (data: Buffer, options?: unknown) => Promise<unknown>;
    download: () => Promise<{ readableStreamBody?: unknown }>;
    deleteIfExists: () => Promise<unknown>;
  };
}> | null = null;

async function getAzureContainerClient() {
  if (!containerClientPromise) {
    containerClientPromise = (async () => {
      const moduleName = "@azure/storage-blob";
      const mod = await import(moduleName);
      const { account, container } = loadCloudBlobConfig(BLOB_STORAGE.AZURE);

      const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING?.trim();
      const sasToken = process.env.AZURE_STORAGE_SAS_TOKEN?.trim();

      if (connectionString) {
        const serviceClient = mod.BlobServiceClient.fromConnectionString(
          connectionString,
        ) as { getContainerClient: (containerName: string) => unknown };
        return serviceClient.getContainerClient(container) as {
          getBlockBlobClient: (key: string) => {
            uploadData: (data: Buffer, options?: unknown) => Promise<unknown>;
            download: () => Promise<{ readableStreamBody?: unknown }>;
            deleteIfExists: () => Promise<unknown>;
          };
        };
      }

      if (sasToken) {
        const normalizedSas = sasToken.startsWith("?")
          ? sasToken
          : `?${sasToken}`;
        const serviceClient = new mod.BlobServiceClient(
          `https://${account}.blob.core.windows.net${normalizedSas}`,
        ) as { getContainerClient: (containerName: string) => unknown };
        return serviceClient.getContainerClient(container) as {
          getBlockBlobClient: (key: string) => {
            uploadData: (data: Buffer, options?: unknown) => Promise<unknown>;
            download: () => Promise<{ readableStreamBody?: unknown }>;
            deleteIfExists: () => Promise<unknown>;
          };
        };
      }

      throw new Error(
        BLOB_CONFIG_ERROR.AZURE_AUTH_REQUIRED,
      );
    })();
  }
  return containerClientPromise;
}

/**
 * Transitional adapter:
 * current attachment schema stores encrypted payload inline in DB.
 * Azure Blob object I/O integration will be added behind this adapter next.
 */
export const azureBlobStore: AttachmentBlobStore = {
  backend: BLOB_STORAGE.AZURE,
  validateConfig() {
    loadCloudBlobConfig(BLOB_STORAGE.AZURE);
  },
  async putObject(data, context) {
    const key = buildObjectKey(context);
    const containerClient = await getAzureContainerClient();
    const blobClient = containerClient.getBlockBlobClient(key);
    await blobClient.uploadData(Buffer.from(data), {
      blobHTTPHeaders: { blobContentType: BLOB_CONTENT_TYPE.OCTET_STREAM },
    });
    return encodeObjectRef({ key });
  },
  async getObject(stored, context) {
    const ref = decodeObjectRef(stored);
    const key = ref?.key ?? buildObjectKey(context);
    const containerClient = await getAzureContainerClient();
    const blobClient = containerClient.getBlockBlobClient(key);
    const download = await blobClient.download();
    return streamBodyToBuffer(download.readableStreamBody);
  },
  async deleteObject(stored, context) {
    const ref = decodeObjectRef(stored);
    const key = ref?.key ?? buildObjectKey(context);
    const containerClient = await getAzureContainerClient();
    const blobClient = containerClient.getBlockBlobClient(key);
    await blobClient.deleteIfExists();
  },
  toStored(data) {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  },
  toBuffer(stored) {
    return Buffer.from(stored);
  },
  toBase64(stored) {
    return Buffer.from(stored).toString("base64");
  },
};
