/* KANBO — the AI project planner (0047 wave, package w3). One import site for the integrator:
   the sheet, plus the wiring helpers from lib/projectPlanner (deps over the store, the workspace's
   people with titles and guests, and the toast after it's made something). */
export { ProjectPlanner, type ProjectPlannerProps } from "./ProjectPlanner";
export { plannerDeps, plannerPeople, plannerResultMessage, type PlannerStore } from "../../lib/projectPlanner";
