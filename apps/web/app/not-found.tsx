import Link from "next/link";
import { EmptyState } from "./_components/operator.js";

export default function NotFound() {
  return <><h1>Record not found</h1><EmptyState>This record is unavailable in the current organization.</EmptyState><Link href="/">Back to encounters</Link></>;
}
