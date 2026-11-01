import { createAppServer } from "./index.mjs";
const port = Number(process.env.PORT ?? 3000), host = process.env.HOST || "127.0.0.1";
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
const server = createAppServer();
server.listen(port, host, () => console.log(`Transplan: http://localhost:${server.address().port}`));
