"use client";

import Image from "next/image";
import { signIn, signOut, useSession } from "next-auth/react";

export function AuthButton() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <span className="auth-status">로그인 확인 중</span>;
  }

  if (!session?.user?.githubId) {
    return (
      <button className="auth-button" type="button" onClick={() => signIn("github")}>
        GitHub 로그인
      </button>
    );
  }

  return (
    <div className="auth-user">
      {session.user.image ? (
        <Image src={session.user.image} alt="" width={24} height={24} unoptimized />
      ) : (
        <span>{session.user.githubLogin.slice(0, 1).toUpperCase()}</span>
      )}
      <strong>{session.user.githubLogin}</strong>
      <button type="button" onClick={() => signOut()}>
        로그아웃
      </button>
    </div>
  );
}
