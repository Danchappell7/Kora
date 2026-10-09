/* KANBO — the template library (0048, u9). One import site for the integrator (lazy-load it:
   lazyViews.ts). The New task menu's words and icon are in ./menu (tiny; safe for the shell). */
export { TemplateLibrary, type TemplateLibraryProps } from "./TemplateLibrary";
export { TemplatePicker, type TemplatePickerProps } from "./TemplatePicker";
export { SaveAsTemplate, type SaveAsTemplateProps } from "./SaveAsTemplate";
export { TemplateChooser, type TemplateChooserProps } from "./TemplateChooser";
export { useLibraryTemplates, type LibraryState } from "./useLibraryTemplates";
