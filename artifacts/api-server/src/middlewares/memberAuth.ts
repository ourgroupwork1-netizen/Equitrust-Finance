import { clerkClient, getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import {
  accountsTable,
  administratorGrantsTable,
  db,
  membersTable,
  type Member,
} from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      equitrustMember?: Member;
    }
  }
}

const OWNER_EMAIL = "ourgroup1@gmail.com";

export async function requireMember(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Sign in to access your account." });
    return;
  }

  try {
    const clerkUser = await clerkClient.users.getUser(userId);
    const primaryEmail = clerkUser.emailAddresses.find(
      (entry) => entry.id === clerkUser.primaryEmailAddressId,
    );
    const email = primaryEmail?.emailAddress.trim().toLowerCase();
    if (!email || primaryEmail?.verification?.status !== "verified") {
      res.status(403).json({ error: "A verified email address is required." });
      return;
    }

    const displayName =
      [clerkUser.firstName, clerkUser.lastName]
        .filter((part): part is string => Boolean(part?.trim()))
        .join(" ") ||
      clerkUser.username ||
      "Equitrust member";
    const isOwner = email === OWNER_EMAIL;
    const [grant] = isOwner
      ? []
      : await db
          .select({ id: administratorGrantsTable.id })
          .from(administratorGrantsTable)
          .where(eq(administratorGrantsTable.email, email))
          .limit(1);

    const member = await db.transaction(async (tx) => {
      const [byClerkId] = await tx
        .select()
        .from(membersTable)
        .where(eq(membersTable.clerkUserId, userId))
        .limit(1);
      const [byEmail] = byClerkId
        ? []
        : await tx
            .select()
            .from(membersTable)
            .where(eq(membersTable.email, email))
            .limit(1);
      const existing = byClerkId ?? byEmail;
      const role = isOwner
        ? "owner"
        : grant || existing?.role === "admin" || existing?.role === "owner"
          ? "admin"
          : "member";

      let current: Member;
      if (existing) {
        const [updated] = await tx
          .update(membersTable)
          .set({
            clerkUserId: userId,
            email,
            displayName,
            role,
            updatedAt: new Date(),
          })
          .where(eq(membersTable.id, existing.id))
          .returning();
        current = updated;
      } else {
        const [created] = await tx
          .insert(membersTable)
          .values({
            clerkUserId: userId,
            email,
            displayName,
            role,
          })
          .returning();
        current = created;
      }

      await tx
        .insert(accountsTable)
        .values({ memberId: current.id })
        .onConflictDoNothing({ target: accountsTable.memberId });

      return current;
    });

    if (member.status === "blocked") {
      res.status(403).json({
        error: "This account is blocked. Contact Equitrust support for review.",
      });
      return;
    }

    req.equitrustMember = member;
    next();
  } catch (error) {
    req.log.error({ error }, "Unable to resolve authenticated member");
    res.status(401).json({ error: "Unable to confirm your account." });
  }
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.equitrustMember || !["admin", "owner"].includes(req.equitrustMember.role)) {
    res.status(403).json({ error: "Administrator access is required." });
    return;
  }
  next();
}

export function requireOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.equitrustMember?.role !== "owner") {
    res.status(403).json({ error: "Only the platform owner can add administrators." });
    return;
  }
  next();
}

export function memberIdFromRequest(req: Request): string {
  if (!req.equitrustMember) {
    throw new Error("Member authentication middleware was not applied.");
  }
  return req.equitrustMember.id;
}