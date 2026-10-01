import type { Meeting } from "@/types"
import { loadSettings, loadSlackWebhookUrl } from "@/lib/storage"
import { httpFetch } from "@/lib/http"

function meetingMarkdown(title: string, body: string): string {
  let md = ""
  if (title.trim()) md += `# ${title.trim()}\n\n`
  md += body.trim()
  return md
}

/** Open a mailto: draft with subject + body (truncated for URL limits). */
export async function shareViaEmail(title: string, body: string): Promise<void> {
  const subject = encodeURIComponent(title.trim() || "Meeting notes")
  const maxBody = 1800
  let text = body.trim()
  if (text.length > maxBody) text = `${text.slice(0, maxBody)}\n\n…(truncated)`
  const mailto = `mailto:?subject=${subject}&body=${encodeURIComponent(text)}`
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener")
    await openUrl(mailto)
  } catch {
    window.open(mailto, "_self")
  }
}

/** Write Markdown into the configured export folder (or pick a path). */
export async function shareExportToFolder(meeting: Meeting): Promise<boolean> {
  const settings = loadSettings()
  const { exportMeetingMarkdown, toMarkdown } = await import("@/lib/export")
  // Prefer dialog export when no folder configured
  if (!settings.exportFolderPath?.trim()) {
    return exportMeetingMarkdown(meeting)
  }
  try {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs")
    const { join } = await import("@tauri-apps/api/path")
    const slug =
      meeting.title.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 60) ||
      "myna-notes"
    const date = meeting.date.slice(0, 10)
    const filename = `${date}-${slug}.md`
    const path = await join(settings.exportFolderPath.trim(), filename)
    const md = typeof toMarkdown === "function" ? toMarkdown(meeting) : meetingMarkdown(meeting.title, meeting.notes)
    await writeTextFile(path, md)
    return true
  } catch {
    return exportMeetingMarkdown(meeting)
  }
}

/** POST notes to a Slack Incoming Webhook. */
export async function shareViaSlack(title: string, body: string): Promise<void> {
  const settings = loadSettings()
  let url = settings.slackWebhookUrl?.trim()
  if (!url) {
    url = (await loadSlackWebhookUrl()).trim()
  }
  if (!url) {
    throw new Error("Add a Slack Incoming Webhook URL in Settings → Share.")
  }
  const text = meetingMarkdown(title, body).slice(0, 35000)
  const res = await httpFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `*${title.trim() || "Meeting notes"}*\n${text}`,
    }),
  })
  if (!res.ok) {
    throw new Error(`Slack webhook failed (${res.status})`)
  }
}
