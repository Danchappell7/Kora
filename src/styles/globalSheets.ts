/* ============================================================
   KANBO — the stylesheets every page has always had, in the order
   they always had: the components' own sheets first, then kanbo.css
   (main.tsx imports this just before it), so on a tie kanbo.css wins.
   Imported here, from the first download, so that splitting the app's
   code by screen never reorders the cascade (a sheet that arrived
   with a lazily-loaded screen would land after kanbo.css and start
   winning its ties). Screens that always brought their own sheet later
   (Docs, the planner, the recycle bin, Developers, Notion, the public
   form) still do.
   ============================================================ */
import "../components/integrations/slack.css";
import "../components/integrations/calendarFeed.css";
import "../components/integrations/calendarAccounts.css";
import "../components/integrations/push.css";
import "../components/integrations/publicLink.css";
import "../components/teamTemplates.css";
import "../components/project/projects.css";
import "../components/tasks/taskViews.css";
import "../components/approvals/approvals.css";
import "../auth/googleButton.css";
import "../components/admin/systemStatus.css";
