import { AppError } from '@/shared/utils.js';

type AuthUser = {
  id: number | bigint;
  username: string;
  role: string;
};

type AuthLoginUser = AuthUser & { password_hash: string; is_active: number };

type AuthDependencies = {
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string, role?: string): AuthUser;
    getUserByUsername(username: string): AuthLoginUser | undefined;
    updateLastLogin(userId: number, ip?: string): void;
    listUsers(): AuthUser[];
    setUserActive(userId: number, isActive: boolean): void;
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthUser): string;
  revokeToken(request: unknown): void;
  userWorkspace: {
    ensureUserWorkspace(userId: number): Promise<void>;
  };
  logWarn(message: string, error?: unknown): void;
};

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function validateAuthUser(user: unknown): AuthUser {
  if (
    typeof user !== 'object'
    || user === null
    || !('id' in user)
    || !('username' in user)
    || !('role' in user)
    || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
    || typeof user.username !== 'string'
    || typeof user.role !== 'string'
  ) {
    throw new AppError('Authenticated user is required', {
      code: 'AUTH_USER_REQUIRED',
      statusCode: 401,
    });
  }
  return user as AuthUser;
}

/**
 * Validates password strength.
 *
 * Requirements:
 * - Minimum 10 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one digit
 */
function validatePasswordStrength(password: string): void {
  if (password.length < 10) {
    throw new AppError(
      'Password must be at least 10 characters',
      { code: 'AUTH_PASSWORD_TOO_SHORT', statusCode: 400 },
    );
  }
  if (!/[A-Z]/.test(password)) {
    throw new AppError(
      'Password must contain at least one uppercase letter',
      { code: 'AUTH_PASSWORD_WEAK', statusCode: 400 },
    );
  }
  if (!/[a-z]/.test(password)) {
    throw new AppError(
      'Password must contain at least one lowercase letter',
      { code: 'AUTH_PASSWORD_WEAK', statusCode: 400 },
    );
  }
  if (!/[0-9]/.test(password)) {
    throw new AppError(
      'Password must contain at least one digit',
      { code: 'AUTH_PASSWORD_WEAK', statusCode: 400 },
    );
  }
}

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  return {
    getStatus() {
      return {
        needsSetup: !dependencies.users.hasUsers(),
        isAuthenticated: false,
      };
    },

    async register(usernameInput: unknown, passwordInput: unknown, ip?: string) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3) {
        throw new AppError(
          'Username must be at least 3 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }
      validatePasswordStrength(password);

      dependencies.transaction.begin();
      try {
        const isFirstUser = !dependencies.users.hasUsers();
        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash, isFirstUser ? 'admin' : 'user');
        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id), ip);

        // Workspace creation is deliberately non-fatal: a failure here is
        // repaired lazily on the next project-list fetch.
        await dependencies.userWorkspace.ensureUserWorkspace(numericUserId(user.id)).catch(
          (error) => dependencies.logWarn('Failed to create user workspace during registration', error),
        );

        return {
          success: true,
          user: { id: user.id, username: user.username, role: user.role },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    async login(usernameInput: unknown, passwordInput: unknown, ip?: string) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      const loginStart = Date.now();
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const user = dependencies.users.getUserByUsername(username);
      const validPassword = user
        ? await dependencies.comparePassword(password, user.password_hash)
        : false;
      const compareMs = Date.now() - loginStart;

      // Diagnostic logging for the two failure branches.  This makes it
      // possible to tell "user does not exist" from "user exists but the
      // password/hash comparison failed" purely from docker logs.
      if (!user) {
        dependencies.logWarn(`[auth] login: user NOT FOUND for username='${username}' (lookup+bccompareMs=${compareMs})`);
      } else if (!validPassword) {
        dependencies.logWarn(`[auth] login: password MISMATCH for username='${username}' (bcrypt compareMs=${compareMs})`);
      }

      if (!user || !validPassword) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      if (!user.is_active) {
        throw new AppError('Account is disabled. Contact your administrator.', {
          code: 'AUTH_ACCOUNT_DISABLED',
          statusCode: 403,
        });
      }

      dependencies.users.updateLastLogin(numericUserId(user.id), ip);
      return {
        success: true,
        user: { id: user.id, username: user.username, role: user.role },
        token: dependencies.generateToken(user),
      };
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    refreshSession(user: unknown) {
      const validated = validateAuthUser(user);
      return { token: dependencies.generateToken(validated) };
    },

    /**
     * Logs out the current user by revoking their JWT token.
     * The request object is needed to extract the token from the
     * Authorization header so it can be added to the blacklist.
     */
    logout(request: unknown) {
      dependencies.revokeToken(request);
      return { success: true, message: 'Logged out successfully' };
    },

    // ── Admin ──────────────────────────────────────────────────────────

    async adminCreateUser(currentUser: unknown, usernameInput: unknown, passwordInput: unknown) {
      const current = validateAuthUser(currentUser);
      if (current.role !== 'admin') {
        throw new AppError('Only administrators can create users', {
          code: 'AUTH_FORBIDDEN',
          statusCode: 403,
        });
      }

      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3) {
        throw new AppError(
          'Username must be at least 3 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }
      validatePasswordStrength(password);

      dependencies.transaction.begin();
      try {
        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash, 'user');
        dependencies.transaction.commit();

        // Non-fatal, like registration: the lazy project-list fallback repairs it.
        await dependencies.userWorkspace.ensureUserWorkspace(numericUserId(user.id)).catch(
          (error) => dependencies.logWarn('Failed to create user workspace during admin user creation', error),
        );

        return {
          success: true,
          user: { id: user.id, username: user.username, role: user.role },
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    adminListUsers(currentUser: unknown) {
      const current = validateAuthUser(currentUser);
      if (current.role !== 'admin') {
        throw new AppError('Only administrators can list users', {
          code: 'AUTH_FORBIDDEN',
          statusCode: 403,
        });
      }
      return { users: dependencies.users.listUsers() };
    },

    adminSetUserActive(currentUser: unknown, targetUserId: unknown, isActive: unknown) {
      const current = validateAuthUser(currentUser);
      if (current.role !== 'admin') {
        throw new AppError('Only administrators can manage users', {
          code: 'AUTH_FORBIDDEN',
          statusCode: 403,
        });
      }
      const userId = typeof targetUserId === 'number' ? targetUserId : Number(targetUserId);
      if (!Number.isFinite(userId) || userId <= 0) {
        throw new AppError('Invalid user ID', { code: 'AUTH_INVALID_USER_ID', statusCode: 400 });
      }
      if (userId === numericUserId(current.id)) {
        throw new AppError('Cannot disable your own account', {
          code: 'AUTH_CANNOT_SELF_DISABLE',
          statusCode: 400,
        });
      }
      dependencies.users.setUserActive(userId, Boolean(isActive));
      return { success: true };
    },
  };
}