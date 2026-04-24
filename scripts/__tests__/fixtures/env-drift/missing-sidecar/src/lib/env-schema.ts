import { z } from "zod";
export const envObject = z.object({
  DATABASE_URL: z.string(),
  NODE_ENV: z.string().default("development"),
  MISSING_SIDECAR_KEY: z.string().optional(),
});
export const envSchema = envObject;
export const getSchemaShape = () => envObject.shape;
