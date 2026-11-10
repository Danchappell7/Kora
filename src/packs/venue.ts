/* ============================================================
   Business pack: padel or sports venue.
   Plain data: change any words, days, targets or tasks here. The
   shorthand (t, before, after, onTheDay) is explained in ./helpers.
   ============================================================ */
import type { WorkspaceTemplate } from "../data/types";
import { after, before, onTheDay, t } from "./helpers";

const COURT_CARE = `> 🧹 How we look after the courts. Anything a player reports goes straight into Reported.
## Every day, before the first booking
[ ] Brush the turf and clear leaves and litter
[ ] Check the nets: height, tension and posts
[ ] Check the doors close and the glass has no cracks
## Every week
[ ] Walk every court: glass, mesh, fixings and lights
[ ] Clean the glass inside and out
[ ] Check the drainage after heavy rain
## Every month
[ ] Top up the sand where the turf shows through, and brush it in
[ ] Check the floodlights and book repairs
## Every year
- Deep clean and decompact the turf
- Lighting service and safety check of the structure`;

const RULES = `> 🏆 The rules every player gets when they enter. Change anything here before entries open.
## Format
- Categories and levels
- Groups, then knockout; matches best of three sets, deciding point at deuce
## Entries
- Entry fee, and what it includes
- Closing date for entries, and the refund policy
## On the day
- Arrive 20 minutes before your first match
- Late by more than 10 minutes: the match is a walkover
- Balls are provided; bring your own racket
## Results and prizes
- Results are posted the same day
- Prizes for winners and runners-up in each category`;

const OPEN_CLOSE = `> 🔑 Whoever opens or closes ticks these off.
## Opening
[ ] Lights on, doors unlocked, music on
[ ] Courts brushed and nets checked
[ ] Today's bookings checked: gaps, coaching and events
[ ] Bar and shop stocked, card machine on
## Closing
[ ] Every court empty and locked
[ ] Lost property bagged and labelled
[ ] Takings counted and the till closed
[ ] Floodlights off, alarm set`;

export const VENUE_PACK: WorkspaceTemplate = {
  id: "pack-venue", name: "Padel or sports venue", emoji: "🎾", hue: "citron",
  audience: "Padel clubs, courts and sports venues",
  summary: "Keep every court playable, run a league counted back from finals day, and fill the quiet hours.",
  updateRhythm: { cadence: "weekly", weekday: 1 },
  projects: [
    {
      key: "courts", name: "Court maintenance", emoji: "🧹", hue: "jade",
      description: "The maintenance rota, the court care routine, and anything players report.",
      sections: ["Rota", "Reported", "Booked in", "Fixed"],
      tasks: [
        t("Rota", "Check glass, fencing, doors and lights on every court", 3, 1, { recurrence: "weekly", description: "The daily brush and net check are part of **Opening checks** in Venue routines." }),
        t("Rota", "Top up and brush in the sand on the turf", 14, 2, { recurrence: "monthly", focusMin: 60 }),
        t("Booked in", "Book the turf deep clean and the floodlight service", 21, 1, { priority: "high" }),
        t("Reported", "Put the QR poster up by every court door", 2, 0.5),
      ],
      form: {
        name: "Report a court problem", description: "Broken glass, a loose net, a light out? Tell us which court and what's wrong.",
        fields: ["description", "priority"],
        poster: { headline: "Problem with this court?", line: "Scan to tell us. Say which court it is." },
      },
      rule: { name: "New reports land in Reported", trigger: "task_created", actions: [{ type: "set_section", value: "Reported" }] },
      docs: [{ title: "Court care routine", icon: "🧹", markdown: COURT_CARE }],
    },
    {
      key: "tournament", name: "League and tournament", emoji: "🏆", hue: "amber",
      description: "A season's league, then its finals day, counted back from finals day.",
      anchor: { label: "Finals day", defaultInDays: 63 },
      sections: ["Plan", "Entries", "League", "Finals day", "After"],
      tasks: [
        before("Plan", "Set the format, categories, entry fee and prizes", 63, 2, { priority: "high", focusMin: 60 }),
        before("Entries", "Open entries and publish the rules", 56, 1.5, { focusMin: 60 }),
        before("Plan", "Line up sponsors and prizes", 49, 3, { focusMin: 90 }),
        before("Entries", "Close entries and make the draw", 42, 2, { priority: "high", focusMin: 60 }),
        before("League", "Publish the league fixtures and message every player", 40, 1.5, { priority: "high", focusMin: 45 }),
        before("League", "Update the league table", 35, 0.5, { recurrence: "weekly", description: "Every week the league runs, until finals day." }),
        before("Finals day", "Book referees and block out the courts for finals day", 21, 1, { priority: "high" }),
        before("Finals day", "Tell the finalists their match times", 5, 1),
        before("Finals day", "Set up: scoreboards, balls, water and first aid", 1, 2),
        onTheDay("Finals day", "Finals day"),
        after("After", "Post results and photos, and thank the sponsors", 3, 1.5, { focusMin: 45 }),
      ],
      docs: [{ title: "League and tournament rules", icon: "🏆", markdown: RULES }],
    },
    {
      key: "bookings", name: "Bookings and front desk", emoji: "📅", hue: "sky",
      description: "Prices, policies, and filling the quiet hours.",
      sections: ["Set up", "Every week", "Issues"],
      tasks: [
        t("Set up", "Agree the cancellation and no-show policy", 4, 1, { priority: "high", description: "**Free cancellation up to**\n\n**Late cancellation or no-show charge**\n\n**Bad weather or a court closed**\n\n**Who can waive a charge**" }),
        t("Set up", "Set peak and off-peak prices", 7, 1.5, { priority: "high", focusMin: 60 }),
        t("Set up", "Write the front desk's answers to the ten most common questions", 10, 2, { focusMin: 60 }),
        t("Every week", "Fill next week's quiet slots: open play, coaching or a social", 3, 1, { recurrence: "weekly", focusMin: 45 }),
        t("Issues", "Answer booking issues and refund requests", 2, 0.5, { recurrence: "weekly" }),
      ],
    },
    {
      key: "routines", name: "Venue routines", emoji: "🔁", hue: "lagoon",
      description: "Opening, closing and the weekly numbers.",
      sections: ["Every day", "Every week", "Every month"],
      tasks: [
        t("Every day", "Opening checks", 0, 0.25, { recurrence: "daily", focusMin: 15, forTeam: true, description: "Work through **Opening and closing checks** in this project's docs." }),
        t("Every day", "Closing checks", 0, 0.25, { recurrence: "daily", focusMin: 15, forTeam: true, description: "Work through **Opening and closing checks** in this project's docs." }),
        t("Every week", "Review court utilisation by day and hour", 6, 0.5, { recurrence: "weekly" }),
        t("Every month", "Count bar and shop stock and reorder", 20, 1, { recurrence: "monthly" }),
      ],
      docs: [
        { title: "Opening and closing checks", icon: "🔑", markdown: OPEN_CLOSE },
        { title: "Weekly venue meeting", icon: "🗒️", from: "meeting", agenda: ["Court utilisation: peak and off-peak", "Booking issues and refunds", "Courts: anything reported or booked in", "Leagues, tournaments and coaching", "This week's priorities"] },
      ],
    },
  ],
  goals: [
    {
      key: "utilisation", name: "Busy courts at every hour", icon: "🎾", description: "Peak hours full, and the quiet ones filling up.",
      links: ["bookings", "routines"],
      keyResults: [
        { name: "Peak-time court utilisation", icon: "⚡", unit: "%", target: 90 },
        { name: "Off-peak court utilisation", icon: "🌙", unit: "%", target: 50 },
      ],
    },
    {
      key: "players", name: "Players keep coming back", icon: "🔁", description: "Leagues, tournaments and a good experience bring people back.",
      links: ["tournament", "bookings"],
      keyResults: [
        { name: "Players who book again within 30 days", icon: "📅", unit: "%", target: 60 },
        { name: "League and tournament entries", icon: "🏆", unit: "players", target: 64 },
      ],
    },
    {
      key: "courts", name: "Every court playable", icon: "🧹", links: ["courts"],
      keyResults: [{ name: "Court problems fixed within 48 hours", icon: "🛠️", unit: "%", target: 90 }],
    },
  ],
  portfolios: [
    { key: "programme", name: "Venue programme", emoji: "🎾", hue: "citron", description: "Leagues, tournaments and the front desk: what brings players back.", projects: ["tournament", "bookings"] },
  ],
};
