import { defineEventHandler } from "h3";
import { handleInternalBrandKit } from "./internal-brand-kit.server";

export default defineEventHandler((event) => handleInternalBrandKit(event.req as Request, {
  async getSessionUser(headers) {
    const { auth, authConfigured } = await import("./auth/server");
    if (!authConfigured) return null;
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    const user = session?.user;
    return user ? { id: user.id, emailVerified: user.emailVerified } : null;
  },
  async getRoleById(id) {
    const { boardOps } = await import("./board-server");
    return boardOps.getOperatorRole(id);
  },
  async isUserDisabled(id) {
    const { boardOps } = await import("./board-server");
    return boardOps.isUserDisabled(id);
  },
}));
