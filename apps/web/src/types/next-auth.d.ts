import "next-auth";
import "next-auth/jwt";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    githubId?: string;
    githubLogin?: string;
  }

  interface Session {
    user: {
      githubId: string;
      githubLogin: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    githubId?: string;
    githubLogin?: string;
  }
}
