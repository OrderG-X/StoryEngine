/**
 * 别名表（投影和撤销核引用共用一套，写作版本 P2a 片 4B 从 project.ts 挪出来）：称呼键 → 已确立名字键，跟着链走到底，防环。
 *
 * 设定卡上的别名指向卡名（换题材长篇实跑 2026-10-27：第 1 章记账员把父亲记成「林父」，作者在林国栋的卡上加了别名「林父」，
 * 投影却还把「林父」当另一个人）：先于出场条目套上；别名正好是另一张卡的名字的不收（那是两个人）。
 * 出场条目里「正文用的称呼 ≠ 已确立名字」就是别名；泛称（generic）只认那一章，不进别名。先出现者优先。
 *
 * 出处（撤销核引用用，history/references.ts）：每条别名记下是哪张卡、哪章哪条出场立的；最后认到的那个人也记是哪张卡、哪章哪条出场立的
 * （胜出的那一个：先卡后出场、先出现者）。`chain` 返回解析经过的每一跳和它的出处，末尾是认到的那个人的出处
 * （Astra 第 11 轮第 1 条：只比名字字符串，删卡重建同名的另一张卡就认不出换了人）。
 */
import type { Card, SettingCardsFile } from "../schema/cards.js";
import { presenceName, type PresenceEntry } from "../schema/ledger.js";
import { nameKey } from "../text/quote.js";

/** 一条别名的出处：给了就记。 */
export type NameSource = string;

export class Names {
  private readonly aliasTo = new Map<string, string>();
  private readonly aliasSource = new Map<string, NameSource>();
  private readonly display = new Map<string, string>();
  /** 已确立名字键 → 立它的那张卡 / 那条出场（胜出的那一个）。 */
  private readonly keySource = new Map<string, NameSource>();

  addCards(cards: SettingCardsFile, sourceOf?: (card: Card) => NameSource): void {
    const cardKeys = new Set(cards.cards.map((card) => nameKey(card.name)));
    for (const card of cards.cards) {
      const key = nameKey(card.name);
      if (!key) continue;
      if (!this.display.has(key)) {
        this.display.set(key, card.name);
        if (sourceOf) this.keySource.set(key, sourceOf(card));
      }
      for (const alias of card.aliases) {
        const aliasKey = nameKey(alias);
        if (aliasKey && aliasKey !== key && !cardKeys.has(aliasKey) && !this.aliasTo.has(aliasKey)) {
          this.aliasTo.set(aliasKey, key);
          if (sourceOf) this.aliasSource.set(aliasKey, sourceOf(card));
        }
      }
    }
  }

  addPresence(entry: PresenceEntry, source?: NameSource): void {
    const name = nameKey(presenceName(entry));
    const used = nameKey(entry.nameUsed);
    if (!this.display.has(name)) {
      this.display.set(name, presenceName(entry));
      if (source !== undefined) this.keySource.set(name, source);
    }
    if (used !== name && !entry.generic && !this.aliasTo.has(used)) {
      this.aliasTo.set(used, name);
      if (source !== undefined) this.aliasSource.set(used, source);
    }
  }

  resolve(raw: string): { readonly key: string; readonly name: string } {
    let key = nameKey(raw);
    const seen = new Set<string>([key]);
    for (let next = this.aliasTo.get(key); next !== undefined && !seen.has(next); next = this.aliasTo.get(key)) {
      seen.add(next);
      key = next;
    }
    return { key, name: this.display.get(key) ?? raw };
  }

  /** 解析链：起点的键、每一跳（出处 → 跳到的键），和 resolve 走的同一条路；末尾是认到的那个人的出处（没人立过是「none」）。 */
  chain(raw: string): readonly string[] {
    let key = nameKey(raw);
    const hops = [key];
    const seen = new Set<string>([key]);
    for (let next = this.aliasTo.get(key); next !== undefined && !seen.has(next); next = this.aliasTo.get(key)) {
      hops.push(`${this.aliasSource.get(key) ?? "?"}>${next}`);
      seen.add(next);
      key = next;
    }
    hops.push(`=${this.keySource.get(key) ?? "none"}`);
    return hops;
  }
}
