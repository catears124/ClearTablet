import { DebugDownload } from "./DebugDownload";
import { FlashCounter } from "./FlashCounter";
import { FlashTool } from "./FlashTool";

export default function Home() {
  const buildSha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;

  return (
    <>
      <FlashTool />
      <FlashCounter buildSha={buildSha} />
      <DebugDownload buildSha={buildSha} />
    </>
  );
}
