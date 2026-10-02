"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import { useAuthStore } from "@/store/auth-store";

function safeInternalPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  return value;
}

export default function TwoFactorPageWrapper() {
  return (
    <Suspense fallback={null}>
      <TwoFactorPage />
    </Suspense>
  );
}

function TwoFactorPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [codes, setCodes] = useState(["", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [enrollMode, setEnrollMode] = useState(false);
  const [enrollPassword, setEnrollPassword] = useState("");
  const [enrollSecret, setEnrollSecret] = useState<{ secret: string; uri: string } | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const target = safeInternalPath(searchParams.get("from"));

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const handleChange = (index: number, value: string) => {
    if (value.length > 1) return;
    const newCodes = [...codes];
    newCodes[index] = value;
    setCodes(newCodes);

    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !codes[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const code = codes.join("");
      const res = await fetch("/api/login/verify-2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.user) {
        if (data?.enrollmentRequired) {
          setEnrollMode(true);
          setError("Set up an authenticator before continuing.");
          setLoading(false);
          return;
        }
        setError(data?.error ?? "Invalid code. Try again.");
        setLoading(false);
        return;
      }
      setAuth(data.user);
      router.push(target);
    } catch {
      setError("Verification failed. Try again.");
      setLoading(false);
    }
  };

  async function enroll() {
    if (!enrollPassword || loading) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/login/enroll-2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password: enrollPassword }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.secret) {
        setError(data?.error ?? "Authenticator setup failed.");
        setLoading(false);
        return;
      }
      setEnrollSecret({ secret: String(data.secret), uri: String(data.otpauthUri ?? "") });
      setEnrollPassword("");
    } catch {
      setError("Network error — authenticator was not changed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-[20px] border border-[#E4E4E7] bg-white p-8 shadow-sm ">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-[#18181B] ">Two-Factor Auth</h1>
        <p className="mt-1 text-sm text-gray-500">Enter the code from your authenticator app</p>
      </div>

      {!enrollMode && !enrollSecret && (
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="flex justify-center gap-2">
          {codes.map((code, i) => (
            <input
              key={i}
              ref={(el) => { inputRefs.current[i] = el; }}
              type="text"
              maxLength={1}
              value={code}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              className="h-14 w-12 rounded-xl border border-[#E4E4E7] bg-[#FAFAFA] text-center text-lg font-bold text-[#18181B] outline-none focus:border-[#6C3BFF] focus:ring-1 focus:ring-[#6C3BFF]/20  "
            />
          ))}
        </div>

        {error && <p className="text-center text-sm text-[#EF4444]">{error}</p>}

        <button
          type="submit"
          disabled={loading || codes.some((c) => !c)}
          className="flex h-11 w-full items-center justify-center rounded-xl bg-[#6C3BFF] text-sm font-semibold text-white transition-colors hover:bg-[#5930E6] disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
        </button>

        <Link
          href="/login"
          className="flex items-center justify-center gap-1 text-sm text-gray-500 transition-colors hover:text-[#18181B] "
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to login
        </Link>
      </form>
      )}
      {enrollMode && !enrollSecret && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">Enter your current password to create a new authenticator setup key.</p>
          <input
            type="password"
            value={enrollPassword}
            onChange={(event) => setEnrollPassword(event.target.value)}
            placeholder="Current password"
            className="h-11 w-full rounded-xl border border-[#E4E4E7] bg-[#FAFAFA] px-4 text-sm outline-none"
          />
          <button type="button" onClick={enroll} disabled={!enrollPassword || loading} className="h-11 w-full rounded-xl bg-[#6C3BFF] text-sm font-semibold text-white disabled:opacity-50">
            {loading ? "Setting up…" : "Create setup key"}
          </button>
        </div>
      )}
      {enrollSecret && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">Add this setup key to an authenticator app, then enter its rotating code.</p>
          <div className="break-all rounded-xl bg-[#F4F4F5] p-4 font-mono text-sm tracking-[0.08em]">{enrollSecret.secret}</div>
          {enrollSecret.uri && <p className="break-all text-[10px] text-gray-400">{enrollSecret.uri}</p>}
          <button type="button" onClick={() => { setEnrollSecret(null); setEnrollMode(false); }} className="h-11 w-full rounded-xl border border-[#E4E4E7] text-sm font-semibold text-[#52525B]">
            Continue to code entry
          </button>
        </div>
      )}
    </div>
  );
}