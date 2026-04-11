import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      hasPasskey?: boolean;
      requirePasskey?: boolean;
      requirePasskeyEnabledAt?: string | null;
      passkeyGracePeriodDays?: number | null;
    };
  }
}
