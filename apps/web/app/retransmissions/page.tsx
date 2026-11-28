import { redirect } from "next/navigation";

/** Pas de page « toutes les retransmissions » : elles sont listées dans « En direct ». */
export default function Retransmissions() { redirect("/direct"); }
