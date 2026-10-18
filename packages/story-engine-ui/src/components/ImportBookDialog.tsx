import { useRef, useState } from "react";
import { previewImportBook } from "../api/client.js";
import type { ImportBookFile, ImportBookRequest, ImportPreview } from "../api/types.js";
import { readTextFile } from "../utils/decodeTextFile.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";

/**
 * 「导入已写的书」（P8）：选写好的 txt / md 文件 → 服务端按章节标题切章、回预览 → 作者看一眼、勾掉不要的 → 导入。
 * 切章在服务端做（预览和导入同一个纯函数），这里只读文件、显示、收勾选。导进来的章都算定稿，记账员在后台从头记账。
 */

interface ImportBookDialogProps {
  readonly open: boolean;
  readonly onCancel: () => void;
  /** 导入（建书、开书）；失败就抛错，弹窗留着显示原因。 */
  readonly onImport: (input: ImportBookRequest) => Promise<void>;
  /** 测试注入。 */
  readonly preview?: (files: readonly ImportBookFile[]) => Promise<ImportPreview>;
  readonly readFile?: (file: File) => Promise<string>;
}

export function formatChars(chars: number): string {
  return chars >= 10_000 ? `${(chars / 10_000).toFixed(1)} 万字` : `${chars} 字`;
}

export default function ImportBookDialog({ open, onCancel, onImport, preview = previewImportBook, readFile = readTextFile }: ImportBookDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<readonly ImportBookFile[]>([]);
  const [split, setSplit] = useState<ImportPreview | null>(null);
  const [include, setInclude] = useState<readonly boolean[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<"reading" | "importing" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setFiles([]);
    setSplit(null);
    setInclude([]);
    setTitle("");
    setBusy(null);
    setError(null);
  };
  const close = () => {
    if (busy === "importing") return;
    reset();
    onCancel();
  };

  const choose = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy("reading");
    setError(null);
    try {
      const read = await Promise.all([...list].map(async (file) => ({ name: file.name, text: await readFile(file) })));
      const next = await preview(read);
      setFiles(read);
      setSplit(next);
      setInclude(next.parts.map((part) => part.kind === "chapter"));
      setTitle((current) => current.trim() || next.suggestedTitle);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const chosen = include.filter(Boolean).length;
  const submit = async () => {
    if (!split || chosen === 0 || busy) return;
    setBusy("importing");
    setError(null);
    try {
      await onImport({ title: title.trim(), files, include });
      reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(null);
    }
  };

  const chapterCount = split?.parts.filter((part) => part.kind === "chapter").length ?? 0;
  let numbered = 0;

  return (
    <Dialog open onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="se-import-book">
        <DialogHeader>
          <DialogTitle>导入已写的书</DialogTitle>
          <DialogDescription>选写好的 txt 或 md 文件，按「第 N 章」这样的标题切章。导进来的章都算定稿，记账员会从第 1 章读起、逐章记账。</DialogDescription>
        </DialogHeader>

        <input
          ref={inputRef}
          accept=".txt,.md,.markdown,text/plain,text/markdown"
          aria-label="选择要导入的文件"
          className="se-import-book-file"
          multiple
          onChange={(event) => void choose(event.target.files)}
          type="file"
        />

        {split ? (
          <>
            <p className="se-import-book-summary" role="status">
              认出 {chapterCount} 章，共 {formatChars(split.totalChars)}
              {split.emptyDropped > 0 ? `；${split.emptyDropped} 个空章（只有标题）没算` : ""}
            </p>
            <ul className="se-import-book-list" aria-label="要导入的章节">
              {split.parts.map((part, index) => {
                const on = include[index] === true;
                if (on) numbered += 1;
                const label = part.kind === "preamble"
                  ? `开头 ${formatChars(part.chars)}（不是章节，勾上就当一章导入）`
                  : `${on ? `第 ${numbered} 章` : "不导"}${part.title ? ` · ${part.title}` : ""}`;
                return (
                  <li key={`${part.file}-${index}`} className={on ? "" : "off"}>
                    <label>
                      <input
                        checked={on}
                        disabled={busy !== null}
                        onChange={() => setInclude((current) => current.map((value, at) => (at === index ? !value : value)))}
                        type="checkbox"
                      />
                      <span className="se-import-book-name">{label}</span>
                      {part.kind === "chapter" ? <small>{formatChars(part.chars)}</small> : null}
                    </label>
                  </li>
                );
              })}
            </ul>
            <label className="se-v2-new-book-label" htmlFor="import-book-title">书名</label>
            <input
              className="se-v2-rename-input"
              disabled={busy !== null}
              id="import-book-title"
              onChange={(event) => setTitle(event.target.value)}
              placeholder="给这本书起个名字…"
              value={title}
            />
          </>
        ) : null}

        {error ? <p className="se-open-book-error" role="alert">{error}</p> : null}

        <DialogFooter>
          <button className="se-v2-dialog-cancel-btn" disabled={busy === "importing"} onClick={close} type="button">取消</button>
          <button className="se-v2-dialog-cancel-btn" disabled={busy !== null} onClick={() => inputRef.current?.click()} type="button">
            {busy === "reading" ? "正在读文件…" : split ? "换文件…" : "选文件…"}
          </button>
          {split ? (
            <button className="se-v2-dialog-confirm-btn" disabled={busy !== null || chosen === 0} onClick={() => void submit()} type="button">
              {busy === "importing" ? "正在导入…" : `导入 ${chosen} 章`}
            </button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
