/* ============================================================
   KANBO — lightweight categorized emoji picker (no dependency).
   Used for project icons and reactions.
   ============================================================ */
import { useState } from "react";

const GROUPS: { label: string; emojis: string[] }[] = [
  { label: "Work", emojis: "📁 🚀 🎨 ⚙️ 📈 📉 🧪 💡 📊 🛠️ 📦 🔮 🌱 📌 🗂️ 📋 📝 ✏️ 🖊️ 🔧 🔨 🧰 ⚡ 🔥 ⭐ 🎯 🏆 🏁 💼 🧱 🔗 🧩 📐 🗃️ 🗄️ 🖥️ 💻 ⌨️ 🖱️ 📱 📞 📡 🛰️ 🔋 💾 📅 📆 🗓️ ⏳ ⌛ 💰 💳 🧾 📎 🔑 🔒 🔓".split(" ") },
  { label: "Smileys", emojis: "😀 😃 😄 😁 😆 😅 😂 🤣 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤔 🤨 😐 😶 🙄 😏 😬 😮‍💨 😌 😔 😴 😷 🤒 🤕 🤢 🥵 🥶 😎 🤓 🧐 😕 🙁 😯 😲 🥺 😳 😱 😨 😰 😢 😭 😤 😠 😡 🤬 🤯 😈 💀 💩 🤡 👻 👽 🤖 🎃".split(" ") },
  { label: "People", emojis: "👍 👎 👏 🙌 🙏 👌 🤌 🤝 💪 ✍️ 🫶 👋 🤙 ✌️ 🤞 🫰 👀 🧠 👤 👥 🧑 👩 👨 🧓 👶 🧑‍💻 👩‍💻 👨‍💻 🕺 💃 🧗 🏃 🚶 🧘 👑 🎓 🥳".split(" ") },
  { label: "Nature", emojis: "🌱 🌿 🍀 🌳 🌲 🌴 🌵 🌷 🌸 🌹 🌻 🌼 💐 🍂 🍁 🍄 🌍 🌎 🌏 🌙 ⭐ 🌟 ✨ ⚡ ☀️ 🌤️ ⛅ 🌧️ ⛈️ ❄️ 🔥 💧 🌊 🌈 🐶 🐱 🦊 🐻 🐼 🐨 🦁 🐯 🦄 🐝 🦋 🐢 🐙 🐳 🐬 🦅".split(" ") },
  { label: "Food", emojis: "🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🌽 🥕 🍞 🧀 🥚 🍔 🍟 🍕 🌭 🌮 🌯 🥗 🍿 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 ☕ 🍵 🍺 🍷 🥂 🍾 🥤".split(" ") },
  { label: "Activity", emojis: "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 ⛳ 🎿 🏂 🏋️ 🤸 🏌️ 🚴 🎮 🎲 🧩 🎯 🎳 🎬 🎤 🎧 🎼 🎹 🥁 🎸 🎺 🎻 ♟️ 🎰 🎨 🖼️".split(" ") },
  { label: "Travel", emojis: "🚗 🚕 🚙 🚌 🏎️ 🚓 🚑 🚒 🚜 🏍️ ✈️ 🚀 🛸 🚁 ⛵ 🚤 🛳️ 🚢 🏠 🏡 🏢 🏬 🏥 🏦 🏨 🏝️ 🏔️ ⛰️ 🌋 🗽 🗼 🏰 🎡 🎢 🗺️ 🧭 ⏰ ⌚".split(" ") },
  { label: "Symbols", emojis: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💕 💯 ✅ ☑️ ✔️ ❌ ⭕ ❗ ❓ ⚠️ 🚫 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🔶 🔷 🔺 🔻 ♻️ 🔔 🚩 🎌".split(" ") },
];

export function EmojiPicker({ onPick, width = 268, height = 220 }: { onPick: (emoji: string) => void; width?: number; height?: number }) {
  const [active, setActive] = useState(0);
  const g = GROUPS[active];
  return (
    <div style={{ width, background: "var(--surface-raised)", borderRadius: "var(--r-lg, 12px)", boxShadow: "var(--e2, var(--shadow-lg))", overflow: "hidden" }}>
      <div role="group" aria-label="Emoji groups" style={{ display: "flex", gap: 2, padding: 4, borderBottom: "1px solid var(--hairline)", overflowX: "auto" }}>
        {GROUPS.map((grp, i) => (
          <button key={grp.label} type="button" onClick={() => setActive(i)} title={grp.label} aria-label={grp.label} aria-pressed={i === active}
            style={{ flexShrink: 0, fontSize: 15, width: 32, height: 28, borderRadius: "var(--r-sm, 6px)", border: "none", cursor: "pointer", background: i === active ? "var(--bg-selected, var(--accent-dim))" : "transparent", lineHeight: 1 }}>{grp.emojis[0]}</button>
        ))}
      </div>
      <div style={{ height, overflowY: "auto", padding: 8 }}>
        <div className="kicker" style={{ margin: "0 2px 6px" }}>{g.label}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
          {g.emojis.map((e, i) => (
            <button key={g.label + i} type="button" onClick={() => onPick(e)} style={{ fontSize: 19, height: 32, borderRadius: "var(--r-sm, 6px)", border: "none", background: "transparent", cursor: "pointer", lineHeight: 1 }}
              onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--fill-1, var(--surface-2))")}
              onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}>{e}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
