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
import { requireOptionalModule } from "@/lib/blob-store/runtime-module";

// The @azure/storage-blob surface this store uses. Each is a library value's
// shape, registered in check-bypass-rls's EXTERNAL_SHAPE_ALLOWLIST with its
// supplying package.
type AzureContainerClient = {
  getBlockBlobClient: (key: string) => {
    uploadData: (data: Buffer, options?: unknown) => Promise<unknown>;
    download: () => Promise<{ readableStreamBody?: unknown }>;
    deleteIfExists: () => Promise<unknown>;
  };
};
type AzureBlobServiceClient = { getContainerClient: (containerName: string) => unknown };
type AzureBlobModule = {
  BlobServiceClient: {
    fromConnectionString: (connectionString: string) => unknown;
  } & (new (endpoint: string) => unknown);
};

let containerClientPromise: Promise<AzureContainerClient> | null = null;

async function getAzureContainerClient() {
  if (!containerClientPromise) {
    containerClientPromise = (async () => {
      const moduleName = "@azure/storage-blob";
      const mod = requireOptionalModule<Record<string, unknown>>(moduleName) as AzureBlobModule;
      const { account, container } = loadCloudBlobConfig(BLOB_STORAGE.AZURE);

      const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING?.trim();
      const sasToken = process.env.AZURE_STORAGE_SAS_TOKEN?.trim();

      if (connectionString) {
        const serviceClient = mod.BlobServiceClient.fromConnectionString(
          connectionString,
        ) as AzureBlobServiceClient;
        return serviceClient.getContainerClient(container) as AzureContainerClient;
      }

      if (sasToken) {
        const normalizedSas = sasToken.startsWith("?")
          ? sasToken
          : `?${sasToken}`;
        const serviceClient = new mod.BlobServiceClient(
          `https://${account}.blob.core.windows.net${normalizedSas}`,
        ) as AzureBlobServiceClient;
        return serviceClient.getContainerClient(container) as AzureContainerClient;
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
