import { Logo } from "../components/Logo";

export const metadata = { title: "Page introuvable" };

/** 404 : en français, aux couleurs du site, avec des sorties utiles. */
export default function NotFound() {
  return (
    <main className="arena-app grid min-h-dvh place-items-center px-4 py-10">
      <div className="panel flex w-full max-w-md flex-col items-center gap-4 p-6 text-center">
        <p className="font-display text-xl font-bold"><Logo /></p>
        <p className="font-display text-5xl font-bold text-neon">404</p>
        <h1 className="text-lg font-semibold">Cette page n'existe pas (ou plus).</h1>
        <p className="text-sm text-muted">Le lien est peut-être incomplet, ou le tournoi, le club ou la partie a été supprimé.</p>
        <div className="flex w-full flex-col gap-2 sm:flex-row">
          <a href="/play" className="neon-btn flex-1 rounded-lg px-3 py-2 font-semibold">Jouer une partie</a>
          <a href="/tournois" className="flex-1 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text">Voir les tournois</a>
        </div>
      </div>
    </main>
  );
}
