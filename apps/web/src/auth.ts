import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [GitHub],
  callbacks: {
    jwt({ token, profile }) {
      if (profile) {
        token.githubId = String(profile.id);
        token.githubLogin = typeof profile.login === "string" ? profile.login : token.name ?? "github-user";
      }
      return token;
    },
    session({ session, token }) {
      session.user.githubId = String(token.githubId ?? "");
      session.user.githubLogin = String(token.githubLogin ?? session.user.name ?? "github-user");
      return session;
    }
  }
});
