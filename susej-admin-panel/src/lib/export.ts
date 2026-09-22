// Formula-injection guard (Shopify-matrix export norm): attacker-controlled
// cells (seller names, refund reasons, ticket subjects) starting with
// =,+,-,@ execute on open in Excel. Prefix-guard with a leading apostrophe.
function safeCell(str: string): string {
  const guarded = /^[=+\-@]/.test(str) ? `'${str}` : str;
  return guarded.includes(",") || guarded.includes('"') ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function safeCellTsv(str: string): string {
  return /^[=+\-@]/.test(str) ? `'${str}` : str;
}

export function exportToCSV<T extends Record<string, unknown>>(
  data: T[],
  filename: string,
  columns: { key: string; label: string }[]
) {
  const header = columns.map((c) => c.label).join(",");
  const rows = data.map((row) =>
    columns.map((c) => {
      const val = row[c.key];
      return safeCell(String(val ?? ""));
    }).join(",")
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function exportToExcel<T extends Record<string, unknown>>(
  data: T[],
  filename: string,
  columns: { key: string; label: string }[]
) {
  const header = columns.map((c) => c.label).join("\t");
  const rows = data.map((row) => columns.map((c) => safeCellTsv(String(row[c.key] ?? ""))).join("\t"));
  const tsv = [header, ...rows].join("\n");
  const blob = new Blob([tsv], { type: "text/tab-separated-values;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}.xls`;
  link.click();
  URL.revokeObjectURL(link.href);
}
