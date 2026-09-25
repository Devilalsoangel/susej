"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/shared/empty-state";
import { apiPatch, apiPost } from "@/lib/api-mutate";
import { Save, Copy, Plus, Check, CheckCircle2, KeyRound } from "lucide-react";

interface AppSettingRow {
  key: string;
  value: unknown;
}

async function persistSetting(key: string, value: unknown) {
  try {
    await apiPatch("app-settings", key, { value });
  } catch {
    // key may not exist yet - create it
    await apiPost("app-settings", { key, value });
  }
}

// Loads every saved app-settings row so tabs hydrate real values instead of
// useState defaults (same pattern as the apiKeys tab).
function useSavedSettings(): Record<string, unknown> {
  const [saved, setSaved] = useState<Record<string, unknown>>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/data/app-settings", { cache: "no-store" })
      .then((res) => res.json())
      .then((body) => {
        if (cancelled) return;
        const next: Record<string, unknown> = {};
        for (const row of (body.rows as AppSettingRow[] | undefined) ?? []) {
          next[row.key] = row.value;
        }
        setSaved(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return saved;
}

function SaveChangesButton({ onSave }: { onSave: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Refusals (e.g. manager role-denied on app-settings) used to close the
  // dialog with only a console.error — the desk believed the save landed.
  const [saveError, setSaveError] = useState<string | null>(null);

  async function confirm() {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      setOpen(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed — nothing was written.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <Button onClick={() => setOpen(true)}>
          <Save className="h-4 w-4" /> Save Changes
        </Button>
        {saved && <p className="text-sm text-[#16A34A]">Settings saved successfully!</p>}
      </div>
      <Dialog open={open} onClose={() => setOpen(false)}>
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#16A34A]/10">
            <CheckCircle2 className="h-6 w-6 text-[#16A34A]" />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-[#18181B] ">Save Changes</h3>
          <p className="mt-2 text-sm text-gray-500">Are you sure you want to save these settings?</p>
          {saveError && <p className="mt-2 text-sm text-[#DC2626]">{saveError}</p>}
          <div className="mt-6 flex justify-center gap-3">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={confirm} disabled={saving}>{saving ? "Saving..." : "Save Changes"}</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

const tabs = [
  { label: "General", value: "general" },
  { label: "Security", value: "security" },
  { label: "Email", value: "email" },
  { label: "Storage", value: "storage" },
  { label: "API Keys", value: "api-keys" },
  { label: "Maintenance", value: "maintenance" },
  { label: "Danger Zone", value: "danger" },
];

function GeneralSettings() {
  const saved = useSavedSettings();
  const [siteName, setSiteName] = useState("SUSEJ");
  const [tagline, setTagline] = useState("Social Commerce Marketplace");
  const [supportEmail, setSupportEmail] = useState("support@susej.com");
  const [language, setLanguage] = useState("en");
  const [timezone, setTimezone] = useState("utc");
  const [currency, setCurrency] = useState("inr");
  const [maintenance, setMaintenance] = useState(false);
  const [registrations, setRegistrations] = useState(true);
  const [guestCheckout, setGuestCheckout] = useState(true);

  useEffect(() => {
    if (typeof saved.siteName === "string") setSiteName(saved.siteName);
    if (typeof saved.tagline === "string") setTagline(saved.tagline);
    if (typeof saved.supportEmail === "string") setSupportEmail(saved.supportEmail);
    if (typeof saved.defaultLanguage === "string") setLanguage(saved.defaultLanguage);
    if (typeof saved.timezone === "string") setTimezone(saved.timezone);
    if (typeof saved.currency === "string") setCurrency(saved.currency);
    if (typeof saved.maintenanceMode === "boolean") setMaintenance(saved.maintenanceMode);
    if (typeof saved.allowNewRegistrations === "boolean") setRegistrations(saved.allowNewRegistrations);
    if (typeof saved.allowGuestCheckout === "boolean") setGuestCheckout(saved.allowGuestCheckout);
  }, [saved]);

  async function save() {
    await Promise.all([
      persistSetting("siteName", siteName),
      persistSetting("tagline", tagline),
      persistSetting("supportEmail", supportEmail),
      persistSetting("defaultLanguage", language),
      persistSetting("timezone", timezone),
      persistSetting("currency", currency),
      persistSetting("maintenanceMode", maintenance),
      persistSetting("allowNewRegistrations", registrations),
      persistSetting("allowGuestCheckout", guestCheckout),
    ]);
  }

  return (
    <div className="space-y-6">
      <p className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-2.5 text-xs text-[#92400E]">
        Recorded settings — maintenance mode, new registrations and guest checkout are saved but not enforced by any buyer lane yet. Enforcement is on the roadmap; do not rely on these toggles today.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div><Label>Site Name</Label><Input value={siteName} onChange={(e) => setSiteName(e.target.value)} /></div>
        <div><Label>Tagline</Label><Input value={tagline} onChange={(e) => setTagline(e.target.value)} /></div>
        <div><Label>Support Email</Label><Input value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)} /></div>
        <div><Label>Default Language</Label><Select options={[{ label: "English", value: "en" }, { label: "Hindi", value: "hi" }, { label: "Spanish", value: "es" }]} value={language} onChange={(e) => setLanguage(e.target.value)} /></div>
        <div><Label>Timezone</Label><Select options={[{ label: "UTC", value: "utc" }, { label: "IST", value: "ist" }, { label: "EST", value: "est" }]} value={timezone} onChange={(e) => setTimezone(e.target.value)} /></div>
        <div><Label>Currency (locked to INR — money formatting is INR-only)</Label><Select options={[{ label: "INR (₹)", value: "inr" }]} value={currency} onChange={(e) => setCurrency(e.target.value)} /></div>
      </div>
      <Separator />
      <div className="space-y-4">
        <Switch label="Maintenance Mode" checked={maintenance} onChange={setMaintenance} />
        <Switch label="Allow New Registrations" checked={registrations} onChange={setRegistrations} />
        <Switch label="Allow Guest Checkout" checked={guestCheckout} onChange={setGuestCheckout} />
      </div>
      <SaveChangesButton onSave={save} />
    </div>
  );
}

function SecuritySettings() {
  const saved = useSavedSettings();
  const [timeoutMins, setTimeoutMins] = useState("60");
  const [maxAttempts, setMaxAttempts] = useState("5");
  const [require2fa, setRequire2fa] = useState(true);
  const [loginAlerts, setLoginAlerts] = useState(true);
  const [rateLimit, setRateLimit] = useState(true);

  useEffect(() => {
    if (typeof saved.sessionTimeout === "number") setTimeoutMins(String(saved.sessionTimeout));
    if (typeof saved.maxLoginAttempts === "number") setMaxAttempts(String(saved.maxLoginAttempts));
    if (typeof saved.require2faForAdmins === "boolean") setRequire2fa(saved.require2faForAdmins);
    if (typeof saved.loginAlerts === "boolean") setLoginAlerts(saved.loginAlerts);
    if (typeof saved.rateLimitApi === "boolean") setRateLimit(saved.rateLimitApi);
  }, [saved]);

  async function save() {
    await Promise.all([
      persistSetting("sessionTimeout", Number(timeoutMins) || 60),
      persistSetting("maxLoginAttempts", Number(maxAttempts) || 5),
      persistSetting("require2faForAdmins", require2fa),
      persistSetting("loginAlerts", loginAlerts),
      persistSetting("rateLimitApi", rateLimit),
    ]);
  }

  return (
    <div className="space-y-6">
      <p className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-2.5 text-xs text-[#92400E]">
        Recorded settings — session timeout, 2FA, login alerts and API rate limiting are saved but not enforced yet. Enforcement is on the security roadmap; do not rely on these toggles today.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div><Label>Session Timeout (minutes)</Label><Input value={timeoutMins} onChange={(e) => setTimeoutMins(e.target.value)} type="number" /></div>
        <div><Label>Max Login Attempts</Label><Input value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} type="number" /></div>
      </div>
      <div className="space-y-4">
        <Switch label="Require 2FA for Admins" checked={require2fa} onChange={setRequire2fa} />
        <Switch label="Send Login Alerts" checked={loginAlerts} onChange={setLoginAlerts} />
        <Switch label="Rate Limit API Requests" checked={rateLimit} onChange={setRateLimit} />
      </div>
      <SaveChangesButton onSave={save} />
      <Rotate2faCard />
    </div>
  );
}

function Rotate2faCard() {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function rotate() {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login/rotate-2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.code) {
        setError(body?.error ?? "Rotation failed.");
        return;
      }
      setCode(String(body.code));
      setPassword("");
    } catch {
      setError("Network error — code not rotated.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-2xl border border-[#E4E4E7] bg-white p-5">
      <h3 className="text-[14px] font-semibold text-[#18181B]">My 2FA code</h3>
      <p className="mt-1 text-[12px] text-[#71717A]">
        Seeded accounts share a bootstrap code — rotate it to a private one. The new code shows once; write it down.
      </p>
      {code ? (
        <div className="mt-3 rounded-xl bg-[#F4F4F5] p-4 text-center">
          <p className="text-[11px] text-[#71717A]">Your new 2FA code (shown once)</p>
          <p className="mt-1 text-[28px] font-bold tracking-[0.3em] text-[#18181B]">{code}</p>
          <button className="mt-2 text-[12px] font-medium text-[#6C3BFF]" onClick={() => setCode(null)}>I saved it — hide</button>
        </div>
      ) : (
        <div className="mt-3 flex items-end gap-3">
          <div className="flex-1">
            <Label>Current password</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Confirm your password" />
          </div>
          <button
            disabled={!password || busy}
            onClick={rotate}
            className="h-9 shrink-0 rounded-[6px] bg-[#18181B] px-4 text-sm font-medium text-white outline-none disabled:opacity-40"
          >
            {busy ? "…" : "Rotate code"}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-[12px] text-[#EF4444]">{error}</p>}
    </div>
  );
}

function EmailSettings() {
  const saved = useSavedSettings();
  const [smtpHost, setSmtpHost] = useState("smtp.sendgrid.net");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("apikey");
  const [smtpPass, setSmtpPass] = useState("SG.xxxxx");
  const [fromEmail, setFromEmail] = useState("noreply@susej.com");
  const [fromName, setFromName] = useState("SUSEJ");
  const [testEmailSent, setTestEmailSent] = useState(false);

  useEffect(() => {
    if (typeof saved.smtpHost === "string") setSmtpHost(saved.smtpHost);
    if (typeof saved.smtpPort === "number") setSmtpPort(String(saved.smtpPort));
    if (typeof saved.smtpUsername === "string") setSmtpUser(saved.smtpUsername);
    if (typeof saved.smtpPassword === "string" && saved.smtpPassword.length > 0) setSmtpPass(saved.smtpPassword);
    if (typeof saved.fromEmail === "string") setFromEmail(saved.fromEmail);
    if (typeof saved.fromName === "string") setFromName(saved.fromName);
  }, [saved]);

  async function save() {
    await Promise.all([
      persistSetting("smtpHost", smtpHost),
      persistSetting("smtpPort", Number(smtpPort) || 587),
      persistSetting("smtpUsername", smtpUser),
      persistSetting("smtpPassword", smtpPass),
      persistSetting("fromEmail", fromEmail),
      persistSetting("fromName", fromName),
    ]);
  }

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-[#18181B] ">SMTP Configuration</h3>
      <div className="grid grid-cols-2 gap-4">
        <div><Label>SMTP Host</Label><Input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} /></div>
        <div><Label>SMTP Port</Label><Input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} type="number" /></div>
        <div><Label>Username</Label><Input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} /></div>
        <div><Label>Password</Label><Input type="password" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} /></div>
        <div><Label>From Email</Label><Input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} /></div>
        <div><Label>From Name</Label><Input value={fromName} onChange={(e) => setFromName(e.target.value)} /></div>
      </div>
      <Separator />
      <h3 className="text-lg font-semibold text-[#18181B] ">Test Email (save-only — no SMTP send yet)</h3>
      <div className="flex items-end gap-4">
        <div className="flex-1"><Label>Send Test To</Label><Input placeholder="admin@susej.com" /></div>
        <Button variant="secondary" onClick={async () => {
          await save();
          setTestEmailSent(true);
        }}>Save Config</Button>
      </div>
      {testEmailSent && <p className="text-sm text-[#16A34A]">SMTP settings saved. No test email was sent — wire an SMTP provider to enable delivery.</p>}
      <SaveChangesButton onSave={save} />
    </div>
  );
}

function StorageSettings() {
  const saved = useSavedSettings();
  const [maxSize, setMaxSize] = useState("10");
  const [quality, setQuality] = useState("80");
  const [cdnUrl, setCdnUrl] = useState("https://cdn.susej.com");
  const [fileTypes, setFileTypes] = useState<string[]>(["jpg", "png", "gif", "webp", "pdf", "mp4"]);
  const allTypes = ["jpg", "png", "gif", "webp", "pdf", "mp4", "mp3", "zip", "docx", "xlsx", "svg"];

  useEffect(() => {
    if (typeof saved.maxUploadSize === "number") setMaxSize(String(saved.maxUploadSize));
    if (typeof saved.imageQuality === "number") setQuality(String(saved.imageQuality));
    if (typeof saved.cdnUrl === "string") setCdnUrl(saved.cdnUrl);
    if (Array.isArray(saved.allowedFileTypes)) {
      setFileTypes(saved.allowedFileTypes.filter((t): t is string => typeof t === "string"));
    }
  }, [saved]);

  function toggleType(type: string) {
    setFileTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  }

  async function save() {
    await Promise.all([
      persistSetting("maxUploadSize", Number(maxSize) || 10),
      persistSetting("imageQuality", Number(quality) || 80),
      persistSetting("cdnUrl", cdnUrl),
      persistSetting("allowedFileTypes", fileTypes),
    ]);
  }

  return (
    <div className="space-y-6">
      <p className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-2.5 text-xs text-[#92400E]">
        Partially enforced — only Max Upload Size gates the uploader today. Image quality, CDN URL and extra file types (PDF/MP4) are saved but ignored: uploads accept PNG/JPG/WebP/GIF only. Wiring the rest is on the roadmap.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div><Label>Max Upload Size (MB)</Label><Input value={maxSize} onChange={(e) => setMaxSize(e.target.value)} type="number" /></div>
        <div><Label>Image Quality (%)</Label><Input value={quality} onChange={(e) => setQuality(e.target.value)} type="number" /></div>
        <div><Label>CDN URL</Label><Input value={cdnUrl} onChange={(e) => setCdnUrl(e.target.value)} /></div>
      </div>
      <div>
        <Label>Allowed File Types</Label>
        <div className="mt-2 flex flex-wrap gap-2">
          {allTypes.map((type) => {
            const selected = fileTypes.includes(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() => toggleType(type)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                  selected
                    ? "border-[#6C3BFF] bg-[#6C3BFF] text-white"
                    : "border-[#E4E4E7] bg-[#FAFAFA] text-gray-500 hover:border-gray-300   "
                }`}
              >
                {selected && <Check className="h-3.5 w-3.5" />}
                {type.toUpperCase()}
              </button>
            );
          })}
        </div>
      </div>
      <SaveChangesButton onSave={save} />
    </div>
  );
}

interface ApiKeyEntry {
  name: string;
  // Full keys are NEVER persisted: only the sha256 hash + last4 survive.
  // `key` remains for reading legacy rows (self-migrated to hashes on load).
  key?: string;
  keyHash?: string;
  last4: string;
  lastUsed: string;
  permissions?: string[];
  expiresAt?: string | null;
  createdAt?: string;
}

function isApiKeyEntry(value: unknown): value is ApiKeyEntry {
  const v = value as ApiKeyEntry | null;
  // Legacy rows are {name, key, lastUsed} with no last4 — accept them so the
  // self-migration below can see and hash them (requiring last4 up front
  // filtered them out first, bricking legacy keys with a bare 401).
  const hasSecret = typeof v?.keyHash === "string" || typeof v?.key === "string";
  return (
    typeof value === "object" &&
    value !== null &&
    typeof v!.name === "string" &&
    typeof v!.lastUsed === "string" &&
    (typeof v!.last4 === "string" || typeof v!.key === "string") &&
    hasSecret
  );
}

async function sha256HexBrowser(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ApiKeysSettings() {
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [permissions, setPermissions] = useState<string[]>(["read"]);
  const [expiration, setExpiration] = useState("30 days");
  const [newKey, setNewKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/data/app-settings", { cache: "no-store" })
      .then((res) => res.json())
      .then(async (body) => {
        if (cancelled) return;
        const row = (body.rows as AppSettingRow[] | undefined)?.find((r) => r.key === "apiKeys");
        if (Array.isArray(row?.value)) {
          let list = row.value.filter(isApiKeyEntry);
          // Self-migration (retired as primary — the data lane migrates
          // server-side on read and strips secrets from served rows, so this
          // finds nothing on fresh reads; kept as defense-in-depth).
          // Legacy rows stored the full key. Hash them once and
          // re-persist hashed so the plaintext never rests again. Legacy
          // human-string expiries ("30 days") never parsed in the gateway —
          // convert them to ISO from createdAt (or now) so they actually end.
          const needsMigration = list.filter(
            (e) => !e.keyHash && e.key
              || (typeof e.expiresAt === "string" && e.expiresAt && Number.isNaN(Date.parse(e.expiresAt)))
          );
          if (needsMigration.length > 0) {
            list = await Promise.all(
              list.map(async (e) => {
                let out = e;
                if (!e.keyHash && e.key) {
                  const keyHash = await sha256HexBrowser(e.key);
                  const { key: _dropped, ...rest } = e;
                  out = { ...rest, keyHash, last4: e.key.slice(-4) };
                }
                if (typeof out.expiresAt === "string" && out.expiresAt && Number.isNaN(Date.parse(out.expiresAt))) {
                  const base = typeof out.createdAt === "string" && out.createdAt ? Date.parse(out.createdAt) : Date.now();
                  out = { ...out, expiresAt: expiryToISO(out.expiresAt, Number.isFinite(base) ? base : Date.now()) };
                }
                return out;
              })
            );
            void persistSetting("apiKeys", list);
          }
          if (!cancelled) setKeys(list);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const permissionOptions = [
    { label: "Read", value: "read" },
    { label: "Write", value: "write" },
    { label: "Admin", value: "admin" },
  ];

  function togglePermission(value: string) {
    setPermissions((prev) =>
      prev.includes(value) ? prev.filter((p) => p !== value) : [...prev, value]
    );
  }

  function generateKey(): string {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const values = new Uint32Array(28);
    crypto.getRandomValues(values);
    return `susej_${Array.from(values, (value) => chars[value % chars.length]).join("")}`;
  }

  // Expiry vocab → ISO timestamp (the gateway enforces via Date.parse, and
  // human strings like "30 days" never parse — those keys silently lived
  // forever). Null = never expires.
  function expiryToISO(choice: string, from: number = Date.now()): string | null {
    if (choice === "never" || choice === "Never") return null;
    const days = choice === "90 days" ? 90 : choice === "1 year" ? 365 : 30;
    return new Date(from + days * 864e5).toISOString();
  }

  async function handleCreate() {
    if (!keyName.trim()) return;
    const key = generateKey();
    // Hash-at-rest: the full key lives ONLY in the show-once dialog below.
    // What persists (and what the settings GET can leak at worst) is the
    // sha256 + last4, which the async app-key gate enforces.
    const keyHash = await sha256HexBrowser(key);
    const next: ApiKeyEntry[] = [
      {
        name: keyName.trim(),
        keyHash,
        last4: key.slice(-4),
        lastUsed: "Never",
        permissions: [...permissions],
        expiresAt: expiryToISO(expiration),
        createdAt: new Date().toISOString(),
      },
      ...keys,
    ];
    setKeys(next);
    void persistSetting("apiKeys", next);
    setNewKey(key);
    setKeyName("");
    setPermissions(["read"]);
    setExpiration("30 days");
  }

  function handleRevoke(name: string) {
    const next = keys.filter((k) => k.name !== name);
    setKeys(next);
    void persistSetting("apiKeys", next);
  }

  return (
    <div className="space-y-6">
      <p className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-2.5 text-xs text-[#92400E]">
        Keys are shown once at creation and stored as hashes — the list below shows only the last 4 characters and cannot reveal a key again.
        Expiry is enforced by the API gateway; revoked or expired keys stop authenticating immediately.
        Scopes are enforced on the admin data write lanes: keys without write/admin are rejected there (read-only integrations stay read-only). Mobile app lanes authenticate by user session, not by these keys. Last-used stamps on every authenticated call — a key that still says Never was never used.
      </p>
      {keys.length > 0 && (
        <div className="space-y-3">
          {keys.map((k, i) => (
            <div key={i} className="flex items-center justify-between rounded-xl border border-[#E4E4E7] px-4 py-3">
              <div>
                <p className="text-sm font-medium text-[#18181B] ">{k.name}</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs text-gray-500">••••{k.last4}</code>
                </div>
                <p className="mt-0.5 text-xs text-gray-400">
                  Last used: {k.lastUsed}
                  {(k.permissions?.length ?? 0) > 0 ? ` · ${k.permissions!.join(", ")}` : ""}
                  {k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}
                </p>
              </div>
              <Button variant="danger" size="sm" onClick={() => handleRevoke(k.name)}>Revoke</Button>
            </div>
          ))}
        </div>
      )}
      {loaded && keys.length === 0 && (
        <EmptyState
          icon={<KeyRound className="h-8 w-8 text-gray-300" />}
          title="No API keys issued yet"
          description="Generate an API key to grant programmatic access to the platform."
          className="py-8"
        />
      )}
      <Button variant="secondary" onClick={() => setDialogOpen(true)}>
        <Plus className="h-4 w-4" /> Add New Key
      </Button>

      <Dialog open={dialogOpen} onClose={() => { setDialogOpen(false); setNewKey(null); }}>
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-[#18181B] ">Add New API Key</h3>
          {newKey ? (
            <div className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#16A34A]/10">
                <CheckCircle2 className="h-6 w-6 text-[#16A34A]" />
              </div>
              <p className="mt-4 text-sm font-medium text-[#18181B] ">Key created successfully!</p>
              <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-[#FAFAFA] px-4 py-3 ">
                <code className="truncate text-xs text-gray-600 ">{newKey}</code>
                <button onClick={() => navigator.clipboard.writeText(newKey)}>
                  <Copy className="h-4 w-4 text-gray-400" />
                </button>
              </div>
              <p className="mt-2 text-xs text-gray-400">Copy it now — you won&apos;t be able to see it again.</p>
              <Button className="mt-5 w-full" onClick={() => setDialogOpen(false)}>Done</Button>
            </div>
          ) : (
            <>
              <div>
                <Label>Key Name</Label>
                <Input placeholder="e.g. Mobile App API Key" value={keyName} onChange={(e) => setKeyName(e.target.value)} />
              </div>
              <div>
                <Label>Permissions</Label>
                <div className="mt-2 flex flex-wrap gap-2">
                  {permissionOptions.map((opt) => {
                    const selected = permissions.includes(opt.value);
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => togglePermission(opt.value)}
                        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                          selected
                            ? "border-[#6C3BFF] bg-[#6C3BFF] text-white"
                            : "border-[#E4E4E7] bg-[#FAFAFA] text-gray-500 hover:border-gray-300   "
                        }`}
                      >
                        {selected && <Check className="h-3.5 w-3.5" />}
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <Label>Expiration</Label>
                <Select
                  options={[
                    { label: "30 days", value: "30 days" },
                    { label: "90 days", value: "90 days" },
                    { label: "1 year", value: "1 year" },
                    { label: "Never expires", value: "never" },
                  ]}
                  value={expiration}
                  onChange={(e) => setExpiration(e.target.value)}
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleCreate} disabled={!keyName.trim()}>Create Key</Button>
              </div>
            </>
          )}
        </div>
      </Dialog>
    </div>
  );
}

function MaintenanceSettings() {
  const saved = useSavedSettings();
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("We are currently undergoing scheduled maintenance. Please check back shortly.");

  useEffect(() => {
    if (typeof saved.maintenanceMode === "boolean") setEnabled(saved.maintenanceMode);
    if (typeof saved.maintenanceMessage === "string") setMessage(saved.maintenanceMessage);
  }, [saved]);

  async function save() {
    await Promise.all([
      persistSetting("maintenanceMode", enabled),
      persistSetting("maintenanceMessage", message),
    ]);
  }

  return (
    <div className="space-y-6">
      <p className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-2.5 text-xs text-[#92400E]">
        Recorded, not enforced yet: flipping this switch stores the flag but no lane reads it — buyers and sellers keep transacting. Enforcement lands with the gateway work; until then treat this as a note, not a kill-switch.
      </p>
      <div className="flex items-center justify-between rounded-xl border border-[#E4E4E7] px-4 py-3">
        <div>
          <p className="text-sm font-medium text-[#18181B] ">Maintenance Mode</p>
          <p className="text-xs text-gray-500">When enabled, only admins can access the platform</p>
        </div>
        <Switch checked={enabled} onChange={setEnabled} />
      </div>
      <Separator />
      <div>
        <Label>Maintenance Message</Label>
        <textarea className="mt-1 w-full rounded-xl border border-[#E4E4E7] bg-transparent p-3 text-sm outline-none focus:border-[#6C3BFF]" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
      </div>
      <SaveChangesButton onSave={save} />
    </div>
  );
}

interface DangerModelResult {
  model: string;
  deleted?: number;
  error?: string;
  skipped?: boolean;
}

const DANGER_AREAS: { area: string; label: string; blurb: string; phrase: string }[] = [
  { area: "orders", label: "Orders", blurb: "Orders, shipments, refunds, disputes, bookings, auctions + bids.", phrase: "DELETE ORDERS" },
  { area: "catalog", label: "Catalog", blurb: "Products, posts, likes, comments, reviews, bundles, food items.", phrase: "DELETE CATALOG" },
  { area: "promotions", label: "Promotions", blurb: "Top sellers, hot deals, featured posts, spotlights, promo purchases, banners.", phrase: "DELETE PROMOTIONS" },
  { area: "community", label: "Community", blurb: "Communities, messages, polls + votes, broadcasts, streams, reels + likes, stories, hashtags, chats, blocks.", phrase: "DELETE COMMUNITY" },
  { area: "sellers", label: "Sellers", blurb: "Seller rows + their documents and audit logs (documents first).", phrase: "DELETE SELLERS" },
  { area: "users", label: "Users", blurb: "Every User row + addresses, payment methods, follows, notifications, tickets, reports. Admins are separate rows — no self-delete.", phrase: "DELETE USERS FOREVER" },
  { area: "sessions", label: "Sessions", blurb: "Every AppSession (forces ALL devices to re-login) + otp: settings keys.", phrase: "DELETE SESSIONS" },
  { area: "media", label: "Media", blurb: "Cloudinary susej/ + susej-probe/ assets only — no database rows.", phrase: "DELETE MEDIA" },
  { area: "full", label: "Everything", blurb: "All areas above, in order. Pre-launch demo reset.", phrase: "DELETE EVERYTHING FOREVER" },
];

// ---- Danger Zone media browse (real Cloudinary assets, selective delete) ----

interface MediaAssetItem {
  public_id: string;
  secure_url: string;
  bytes: number;
  width: number;
  height: number;
  created_at: string;
  folder: string;
  scope: "demo" | "app" | "other";
}

function isMediaAssetItem(value: unknown): value is MediaAssetItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.public_id === "string" &&
    typeof v.secure_url === "string" &&
    typeof v.bytes === "number" &&
    typeof v.width === "number" &&
    typeof v.height === "number" &&
    typeof v.created_at === "string" &&
    typeof v.folder === "string" &&
    (v.scope === "demo" || v.scope === "app" || v.scope === "other")
  );
}

// Server-provided error text when present, human fallback otherwise —
// transport statuses never leak into the UI.
function serverMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const err = (body as Record<string, unknown>).error;
    if (typeof err === "string" && err) return err;
  }
  return fallback;
}

function parseCountsBody(body: unknown): {
  counts: Record<string, number>;
  isSuper: boolean;
  mediaError: string | null;
} | null {
  if (typeof body !== "object" || body === null) return null;
  const v = body as Record<string, unknown>;
  if (typeof v.counts !== "object" || v.counts === null || typeof v.isSuper !== "boolean") return null;
  const counts: Record<string, number> = {};
  for (const [k, n] of Object.entries(v.counts)) {
    if (typeof n === "number" && Number.isFinite(n)) counts[k] = n;
  }
  const mediaError = typeof v.mediaError === "string" && v.mediaError ? v.mediaError : null;
  return { counts, isSuper: v.isSuper, mediaError };
}

function parseMediaListBody(body: unknown): { resources: MediaAssetItem[]; nextCursor: string | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const v = body as Record<string, unknown>;
  if (!Array.isArray(v.resources)) return null;
  const list: unknown[] = v.resources;
  const resources = list.filter(isMediaAssetItem);
  const nextCursor = typeof v.next_cursor === "string" && v.next_cursor ? v.next_cursor : null;
  return { resources, nextCursor };
}

function parsePurgeBody(body: unknown): { results: DangerModelResult[]; totalDeleted: number } | null {
  if (typeof body !== "object" || body === null) return null;
  const v = body as Record<string, unknown>;
  if (!Array.isArray(v.results)) return null;
  const list: unknown[] = v.results;
  const results: DangerModelResult[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.model !== "string") continue;
    const row: DangerModelResult = { model: r.model };
    if (typeof r.deleted === "number") row.deleted = r.deleted;
    if (typeof r.error === "string") row.error = r.error;
    if (typeof r.skipped === "boolean") row.skipped = r.skipped;
    results.push(row);
  }
  const totalDeleted =
    typeof v.totalDeleted === "number" ? v.totalDeleted : results.reduce((n, r) => n + (r.deleted ?? 0), 0);
  return { results, totalDeleted };
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function formatAssetDate(value: string): string {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function parseKeepPrefixes(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function DangerZoneSettings() {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [mediaCountNote, setMediaCountNote] = useState<string | null>(null);
  const [isSuper, setIsSuper] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmArea, setConfirmArea] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [result, setResult] = useState<{ area: string; results: DangerModelResult[]; totalDeleted: number } | null>(null);
  // Media browse: real Cloudinary assets with selective delete (never blind).
  const [mediaOpen, setMediaOpen] = useState(false);
  const [mediaAssets, setMediaAssets] = useState<MediaAssetItem[]>([]);
  const [mediaCursor, setMediaCursor] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [keepText, setKeepText] = useState("");

  async function fetchCounts(): Promise<void> {
    const res = await fetch("/api/admin/danger", { cache: "no-store", credentials: "include" });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(serverMessage(body, "Could not load danger zone — please retry."));
    const parsed = parseCountsBody(body);
    if (!parsed) throw new Error("Could not load danger zone — please retry.");
    setCounts(parsed.counts);
    setIsSuper(parsed.isSuper);
    setMediaCountNote(parsed.mediaError);
  }

  // Counts refresh after a purge is best-effort — the result card below
  // already reports what was deleted.
  async function refreshCountsQuiet(): Promise<void> {
    try {
      await fetchCounts();
    } catch {
      // Intentionally silent: post-delete counts are a nicety, not the proof.
    }
  }

  async function loadMedia(cursor: string | null, append: boolean): Promise<void> {
    setMediaLoading(true);
    setMediaError(null);
    try {
      const url = cursor
        ? `/api/admin/danger?list=media&cursor=${encodeURIComponent(cursor)}`
        : "/api/admin/danger?list=media";
      const res = await fetch(url, { cache: "no-store", credentials: "include" });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(serverMessage(body, "Could not load media assets — please retry."));
      const parsed = parseMediaListBody(body);
      if (!parsed) throw new Error("Could not load media assets — please retry.");
      setMediaAssets((prev) => (append ? [...prev, ...parsed.resources] : parsed.resources));
      setMediaCursor(parsed.nextCursor);
    } catch (e) {
      setMediaError(e instanceof Error ? e.message : "Could not load media assets — please retry.");
    } finally {
      setMediaLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetchCounts().catch((e) => {
      if (!cancelled) setLoadError(e instanceof Error ? e.message : "Could not load danger zone — please retry.");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isSuper === null && !loadError) {
    return <p className="text-sm text-gray-500">Loading danger zone…</p>;
  }
  if (loadError) {
    return <p className="text-sm text-[#DC2626]">{loadError}</p>;
  }
  if (!isSuper) {
    return (
      <div className="rounded-2xl border border-[#E4E4E7] bg-[#FAFAFA] p-6 text-center">
        <p className="text-sm font-semibold text-[#18181B]">Super Admin only</p>
        <p className="mt-1 text-xs text-gray-500">Data purges need a Super Admin session. Your role can view settings but cannot wipe demo data.</p>
      </div>
    );
  }

  function openConfirm(area: string) {
    setConfirmArea(area);
    setTyped("");
    setPostError(null);
    setResult(null);
  }

  const allMediaSelected =
    mediaAssets.length > 0 && mediaAssets.every((a) => selectedIds.includes(a.public_id));

  function toggleMediaId(publicId: string) {
    setSelectedIds((prev) =>
      prev.includes(publicId) ? prev.filter((id) => id !== publicId) : [...prev, publicId]
    );
  }

  function toggleMediaAll() {
    setSelectedIds((prev) => {
      const all = mediaAssets.length > 0 && mediaAssets.every((a) => prev.includes(a.public_id));
      return all ? [] : mediaAssets.map((a) => a.public_id);
    });
  }

  function toggleMediaBrowse() {
    if (!mediaOpen && mediaAssets.length === 0 && !mediaLoading) void loadMedia(null, false);
    setMediaOpen(!mediaOpen);
  }

  async function runPurge() {
    const def = DANGER_AREAS.find((a) => a.area === confirmArea);
    if (!def || busy) return;
    // Client checks equality before POST — the server re-checks and 400s anyway.
    if (typed !== def.phrase) {
      setPostError(`Type ${def.phrase} exactly to confirm.`);
      return;
    }
    setBusy(true);
    setPostError(null);
    try {
      // Media bulk wipe honors keep-prefixes so core images are never blindly
      // wiped; other areas POST the bare area+phrase exactly as before.
      const payload: { area: string; phrase: string; keepPrefixes?: string[] } =
        def.area === "media"
          ? { area: def.area, phrase: typed, keepPrefixes: parseKeepPrefixes(keepText) }
          : { area: def.area, phrase: typed };
      const res = await fetch("/api/admin/danger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(serverMessage(body, "Purge failed — nothing was removed."));
      const parsed = parsePurgeBody(body);
      if (!parsed) throw new Error("Purge failed — nothing was removed.");
      setResult({
        area: def.area,
        results: parsed.results,
        totalDeleted: parsed.totalDeleted,
      });
      setConfirmArea(null);
      setTyped("");
      await refreshCountsQuiet();
      if (def.area === "media") {
        setSelectedIds([]);
        await loadMedia(null, false);
      }
    } catch (e) {
      setPostError(e instanceof Error ? e.message : "Purge failed — nothing was removed.");
    } finally {
      setBusy(false);
    }
  }

  // Selective media delete: ONLY the ticked assets, behind the same
  // typed-phrase confirm as the bulk wipe.
  async function runDeleteSelected() {
    const def = DANGER_AREAS.find((a) => a.area === "media");
    if (!def || busy) return;
    if (typed !== def.phrase) {
      setPostError(`Type ${def.phrase} exactly to confirm.`);
      return;
    }
    if (selectedIds.length === 0) {
      setPostError("Select at least one asset first.");
      return;
    }
    setBusy(true);
    setPostError(null);
    try {
      const res = await fetch("/api/admin/danger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ area: "media", phrase: typed, publicIds: selectedIds }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(serverMessage(body, "Delete failed — nothing was removed."));
      const parsed = parsePurgeBody(body);
      if (!parsed) throw new Error("Delete failed — nothing was removed.");
      setResult({
        area: "media",
        results: parsed.results,
        totalDeleted: parsed.totalDeleted,
      });
      setSelectedIds([]);
      await refreshCountsQuiet();
      await loadMedia(null, false);
    } catch (e) {
      setPostError(e instanceof Error ? e.message : "Delete failed — nothing was removed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border-2 border-[#DC2626] bg-[#FEF2F2] p-5">
        <h3 className="text-[15px] font-bold text-[#991B1B]">Danger Zone — pre-launch demo cleanup</h3>
        <p className="mt-1 text-xs text-[#991B1B]">
          No undo without a Neon snapshot — snapshot first. Admins, settings, audit trail, categories, coupons and money books are never touched.
        </p>
      </div>
      <div className="space-y-3">
        {DANGER_AREAS.map((def) => (
          <div key={def.area} className="rounded-2xl border border-[#E4E4E7] bg-white px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[#18181B]">
                  {def.label}
                  <span className="ml-2 rounded-full bg-[#F4F4F5] px-2 py-0.5 text-xs font-medium text-gray-500">
                    {counts?.[def.area] ?? "…"} {def.area === "media" ? "assets" : "rows"}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-gray-500">{def.blurb}</p>
                {def.area === "media" && (
                  <div className="mt-1.5">
                    <button
                      type="button"
                      onClick={toggleMediaBrowse}
                      className="text-xs font-medium text-[#6C3BFF] hover:underline"
                    >
                      {mediaOpen ? "Hide assets" : "Browse assets"}
                    </button>
                    {mediaCountNote && <p className="mt-1 text-xs text-[#92400E]">{mediaCountNote}</p>}
                  </div>
                )}
              </div>
              <Button variant="danger" size="sm" onClick={() => openConfirm(def.area)}>
                Wipe {def.label}
              </Button>
            </div>
            {def.area === "media" && mediaOpen && (
              <div className="mt-3 rounded-xl border border-[#E4E4E7] bg-[#FAFAFA] p-4">
                <div>
                  <Label>Keep prefixes (comma-separated)</Label>
                  <Input
                    value={keepText}
                    onChange={(e) => setKeepText(e.target.value)}
                    placeholder="susej/core/"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Bulk wipe skips assets whose id starts with these — core images stay safe.
                    Selected delete removes only what you tick.
                  </p>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <Checkbox
                    id="media-select-all"
                    checked={allMediaSelected}
                    onChange={toggleMediaAll}
                    label={allMediaSelected ? "Deselect all" : `Select all (${mediaAssets.length})`}
                  />
                  <span className="text-xs text-gray-500">{selectedIds.length} selected</span>
                </div>
                {mediaLoading && mediaAssets.length === 0 ? (
                  <p className="mt-3 text-xs text-gray-500">Loading assets…</p>
                ) : mediaError ? (
                  <div className="mt-3">
                    <p className="text-xs text-[#DC2626]">{mediaError}</p>
                    <button
                      type="button"
                      onClick={() => void loadMedia(null, false)}
                      className="mt-1 text-xs font-medium text-[#6C3BFF] hover:underline"
                    >
                      Retry
                    </button>
                  </div>
                ) : mediaAssets.length === 0 ? (
                  <p className="mt-3 text-xs text-gray-500">No assets under susej/ or susej-probe/.</p>
                ) : (
                  <>
                    <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
                      {mediaAssets.map((a) => (
                        <div key={a.public_id} className="overflow-hidden rounded-xl border border-[#E4E4E7] bg-white">
                          <div className="relative">
                            {a.secure_url ? (
                              <img
                                src={a.secure_url}
                                alt={a.public_id}
                                className="h-24 w-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <div className="flex h-24 w-full items-center justify-center bg-[#F4F4F5] text-xs text-gray-400">
                                No preview
                              </div>
                            )}
                            <div className="absolute left-2 top-2">
                              <Checkbox
                                id={`media-${a.public_id}`}
                                checked={selectedIds.includes(a.public_id)}
                                onChange={() => toggleMediaId(a.public_id)}
                              />
                            </div>
                            <span
                              className={`absolute right-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                a.scope === "demo"
                                  ? "bg-[#FEF3C7] text-[#92400E]"
                                  : a.scope === "app"
                                    ? "bg-[#EDE9FE] text-[#5B21B6]"
                                    : "bg-[#F4F4F5] text-gray-500"
                              }`}
                            >
                              {a.scope}
                            </span>
                          </div>
                          <div className="px-2 py-1.5">
                            <p className="truncate text-[11px] font-medium text-[#18181B]" title={a.public_id}>
                              {a.public_id}
                            </p>
                            <p className="mt-0.5 text-[11px] text-gray-500">
                              {formatBytes(a.bytes)} · {formatAssetDate(a.created_at)}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <p className="text-xs text-gray-500">
                        {mediaAssets.length} shown{mediaCursor ? " — more available" : ""}
                      </p>
                      {mediaCursor && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void loadMedia(mediaCursor, true)}
                          disabled={mediaLoading}
                        >
                          {mediaLoading ? "Loading…" : "Load more"}
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            {confirmArea === def.area && (
              <div className="mt-3 rounded-xl border border-[#FCA5A5] bg-[#FEF2F2] p-4">
                <p className="text-xs font-semibold text-[#991B1B]">
                  Type <code className="rounded bg-white px-1.5 py-0.5 font-mono">{def.phrase}</code> to wipe {def.label}. No undo without a snapshot.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={def.phrase}
                  />
                </div>
                {postError && <p className="mt-2 text-xs text-[#DC2626]">{postError}</p>}
                {def.area === "media" && (
                  <p className="mt-2 text-xs text-[#991B1B]">
                    Delete selected removes only the ticked assets. Confirm wipe removes everything
                    except the keep-prefixes above.
                  </p>
                )}
                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={() => { setConfirmArea(null); setTyped(""); setPostError(null); }}>
                    Cancel
                  </Button>
                  {def.area === "media" && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={runDeleteSelected}
                      disabled={busy || typed !== def.phrase || selectedIds.length === 0}
                    >
                      {busy ? "Deleting…" : `Delete selected (${selectedIds.length})`}
                    </Button>
                  )}
                  <Button variant="danger" size="sm" onClick={runPurge} disabled={busy || typed !== def.phrase}>
                    {busy ? "Wiping…" : `Confirm wipe ${def.label}`}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <Separator />
      {result && (
        <div className="rounded-2xl border border-[#E4E4E7] bg-white p-4">
          <p className="text-sm font-semibold text-[#18181B]">
            {result.area === "media"
              ? `Media delete — ${result.totalDeleted} assets deleted`
              : `${result.area} wiped — ${result.totalDeleted} rows deleted`}
          </p>
          <ul className="mt-2 space-y-1">
            {result.results.map((r, i) => (
              <li key={i} className="text-xs text-gray-600">
                {r.model}:{" "}
                {typeof r.deleted === "number" ? (
                  <span className="font-medium text-[#16A34A]">{r.deleted} deleted</span>
                ) : r.skipped ? (
                  <span className="font-medium text-gray-400">skipped{r.error ? ` — ${r.error}` : ""}</span>
                ) : (
                  <span className="font-medium text-[#DC2626]">failed{r.error ? ` — ${r.error}` : ""}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#18181B] ">Settings</h1>
        <p className="mt-1 text-sm text-gray-500">Configure platform settings</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Platform Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs tabs={tabs}>
            {(active) => (
              <>
                {active === "general" && <GeneralSettings />}
                {active === "security" && <SecuritySettings />}
                {active === "email" && <EmailSettings />}
                {active === "storage" && <StorageSettings />}
                {active === "api-keys" && <ApiKeysSettings />}
                {active === "maintenance" && <MaintenanceSettings />}
                {active === "danger" && <DangerZoneSettings />}
              </>
            )}
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}