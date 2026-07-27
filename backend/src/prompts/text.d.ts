// Prompt files are bundled by esbuild's `text` loader (configured on the
// NodejsFunction in lib/app-stack.ts) so they ship inside the Lambda artifact.
declare module '*.txt' {
  const content: string;
  export default content;
}
