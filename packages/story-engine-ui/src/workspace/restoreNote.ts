/** 操作历史里恢复成功后，在对话里记一行（不走模型；存进会话文件，退出重开也在）。 */
import { saveChatNow } from "../sync/chatSync.js";
import { useChatStore } from "../stores/chatStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { restoreNoteMessage } from "../utils/restoreNote.js";

/** 换了书、对话正在跑就不记（那一轮跑完自己会报盘上的真相）；没存上如实说。 */
export async function noteRestoreInChat(projectPath: string, label: string): Promise<void> {
  if (useNavigationStore.getState().projectPath !== projectPath) return;
  const chat = useChatStore.getState();
  if (chat.chatLoading) return;
  chat.appendMessage(restoreNoteMessage(label));
  const saved = await saveChatNow();
  if (!saved.ok) {
    useNavigationStore.getState().showToast(`恢复已完成，但对话里没记上这一笔（${saved.error}），重开后旧的「下一步」可能还挂着。`, 5200);
  }
}
