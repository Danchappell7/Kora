/* ============================================================
   KANBO — every 0048 row parser, limit and failure mapper in one place
   (for tests and lazily loaded code).                 [architect: final]
     profiles.onboarding / projects.board_settings   ./profileState
     saved_views                                     ./viewRows
     task_templates                                  ./templateRows
     kudos / give_kudos()                            ./kudosRows
     notification_snoozes                            ./snoozeRows
     search_all()                                    ./searchRows (+ ./searchFilters)
   FIRST-DOWNLOAD RULE: code in the shell (store, Sidebar, Today/Plan/Week,
   ListView, MobileNav, Topbar, nav) imports the domain file it needs —
   never this barrel. Rollup puts a module the shell imports into the first
   download together with every export any lazy chunk uses from it; small
   domain files keep that to what the shell itself needs.
   ============================================================ */
export * from "./profileState";
export * from "./viewRows";
export * from "./templateRows";
export * from "./kudosRows";
export * from "./snoozeRows";
export * from "./searchRows";
