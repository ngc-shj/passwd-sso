export const BLOB_CONTENT_TYPE = {
  OCTET_STREAM: "application/octet-stream",
} as const;

export const BLOB_OBJECT_SCOPE = {
  PERSONAL: "personal",
  TEAM: "team",
} as const;

export const BLOB_CONFIG_ERROR = {
  S3_REQUIRED: "S3 backend requires AWS_REGION and S3_ATTACHMENTS_BUCKET",
  AZURE_REQUIRED:
    "Azure backend requires AZURE_STORAGE_ACCOUNT and AZURE_BLOB_CONTAINER",
  GCS_REQUIRED: "GCS backend requires GCS_ATTACHMENTS_BUCKET",
  NON_CLOUD: "Cloud blob config requested for non-cloud backend",
  AZURE_AUTH_REQUIRED:
    "Azure backend requires AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_SAS_TOKEN",
} as const;
