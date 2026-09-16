import { DebugDownload } from "./DebugDownload";
import { FlashTool } from "./FlashTool";

export default function Home() {
  const buildSha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;

  return (
    <>
      <FlashTool />
      <DebugDownload buildSha={buildSha} />
    </>
  );
}
