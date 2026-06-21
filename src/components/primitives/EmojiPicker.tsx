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
    <div style={{ width, background: "var(--surface-raised)", borderRadius: 12, border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)", overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 2, padding: 6, borderBottom: "1px solid var(--hairline)", overflowX: "auto" }}>
        {GROUPS.map((grp, i) => (
          <button key={grp.label} onClick={() => setActive(i)} title={grp.label}
            style={{ flexShrink: 0, fontSize: 15, width: 30, height: 28, borderRadius: 7, border: "none", cursor: "pointer", background: i === active ? "var(--accent-dim)" : "transparent", lineHeight: 1 }}>{grp.emojis[0]}</button>
        ))}
      </div>
      <div style={{ height, overflowY: "auto", padding: 8 }}>
        <div className="kicker" style={{ marginBottom: 6 }}>{g.label}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
          {g.emojis.map((e, i) => (
            <button key={g.label + i} onClick={() => onPick(e)} style={{ fontSize: 19, height: 32, borderRadius: 7, border: "none", background: "transparent", cursor: "pointer", lineHeight: 1 }}
              onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}>{e}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
