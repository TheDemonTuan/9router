import Link from "next/link";
import RtkStats from "../RtkStats";
import SessionDedupStats from "../SessionDedupStats";

export default function TokenSaverMetricsPage() {
  return <div className="space-y-6 p-6">
    <div className="flex items-center justify-between gap-4"><h2 className="text-lg font-semibold">Token Saver Metrics</h2><Link href="/dashboard/token-saver" className="text-primary underline text-sm">Settings</Link></div>
    <RtkStats />
    <SessionDedupStats />
  </div>;
}
