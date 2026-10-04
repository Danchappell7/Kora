/* ============================================================
   KANBO — the public request form page, /f/:token.        [f9-public-forms]
   Rendered by main.tsx BEFORE auth (no AuthProvider, no App): anyone with
   the link can submit a request into the project's form. Branded with the
   project's cover / tile, Paper theme by default and system dark
   respected, mobile-first, accessible; states: loading, form, sending,
   thank-you (with the reference), disabled, not found, rate-limited,
   offline. /f/demo previews it with demo data (no network).
   CONTRACT STUB — f9 replaces the body, keeps the default export, the
   named export and the props.
   ============================================================ */

export interface PublicFormPageProps {
  token: string;
}

export function PublicFormPage(props: PublicFormPageProps) {
  void props;
  return null;
}

export default PublicFormPage;
