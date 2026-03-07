-- AlterTable
ALTER TABLE "users" ADD COLUMN     "kdf_iterations" INTEGER NOT NULL DEFAULT 600000,
ADD COLUMN     "kdf_memory" INTEGER,
ADD COLUMN     "kdf_parallelism" INTEGER,
ADD COLUMN     "kdf_type" INTEGER NOT NULL DEFAULT 0;
