import { expect, test } from "bun:test";
import { SqliteAuthCredentialStore, type AuthCredential } from "@oh-my-pi/pi-ai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROVIDER_ID } from "../src/constants.js";

function oauthCredential(accountId: string, access: string, refresh: string, email: string): AuthCredential {
	return {
		type: "oauth",
		access,
		refresh,
		expires: Date.now() + 3_600_000,
		accountId,
		email,
	};
}

test("host store appends distinct accounts and replaces same identity", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "grok-build-auth-"));
	const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
	try {
		store.upsertAuthCredentialForProvider(
			PROVIDER_ID,
			oauthCredential("acct-a", "access-a1", "refresh-a1", "a@example.com"),
		);
		store.upsertAuthCredentialForProvider(
			PROVIDER_ID,
			oauthCredential("acct-b", "access-b1", "refresh-b1", "b@example.com"),
		);

		const afterAppend = store.listAuthCredentials(PROVIDER_ID);
		expect(afterAppend).toHaveLength(2);
		const accountIds = afterAppend.map(row =>
			row.credential.type === "oauth" ? row.credential.accountId : undefined,
		);
		expect(accountIds).toContain("acct-a");
		expect(accountIds).toContain("acct-b");

		store.upsertAuthCredentialForProvider(
			PROVIDER_ID,
			oauthCredential("acct-a", "access-a2", "refresh-a2", "a@example.com"),
		);

		const afterReplace = store.listAuthCredentials(PROVIDER_ID);
		expect(afterReplace).toHaveLength(2);

		const acctARows = afterReplace.filter(
			row => row.credential.type === "oauth" && row.credential.accountId === "acct-a",
		);
		expect(acctARows).toHaveLength(1);
		const replaced = acctARows[0]?.credential;
		expect(replaced?.type).toBe("oauth");
		if (replaced?.type !== "oauth") {
			throw new Error("expected oauth credential for acct-a");
		}
		expect(replaced.access).toBe("access-a2");
		expect(replaced.refresh).toBe("refresh-a2");
	} finally {
		store.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
