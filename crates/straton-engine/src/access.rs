use crate::store;
use anyhow::{Result, ensure};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};

#[derive(Clone, Debug, Serialize)]
pub struct User {
    pub id: String,
    pub name: String,
    pub disabled: bool,
    pub created_at: i64,
}
#[derive(Clone, Debug, Serialize)]
pub struct Role {
    pub id: String,
    pub name: String,
    pub is_admin: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct Grant {
    pub id: String,
    pub role_id: String,
    pub target_kind: String,
    pub target_id: String,
    pub privilege: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Principal {
    pub user: User,
    pub roles: Vec<Role>,
    pub grants: Vec<Grant>,
}
#[derive(Clone, Copy)]
pub struct Target<'a> {
    pub source: Option<&'a str>,
    pub dataset: Option<&'a str>,
}
impl Principal {
    pub fn admin(&self) -> bool {
        self.roles.iter().any(|r| r.is_admin)
    }
    pub fn allows(&self, privilege: &str, target: Target<'_>) -> bool {
        self.admin()
            || self.grants.iter().any(|g| {
                (g.privilege == privilege || g.privilege == "admin")
                    && ((g.target_kind == "source" && target.source == Some(g.target_id.as_str()))
                        || (g.target_kind == "dataset"
                            && target.dataset == Some(g.target_id.as_str())))
            })
    }
    pub fn has(&self, privilege: &str) -> bool {
        self.admin()
            || self
                .grants
                .iter()
                .any(|g| g.privilege == privilege || g.privilege == "admin")
    }
    pub fn read_roles(&self, source: &str, dataset: &str) -> Vec<&Role> {
        self.roles
            .iter()
            .filter(|r| {
                r.is_admin
                    || self.grants.iter().any(|g| {
                        g.role_id == r.id
                            && ["read", "admin"].contains(&g.privilege.as_str())
                            && ((g.target_kind == "source" && g.target_id == source)
                                || (g.target_kind == "dataset" && g.target_id == dataset))
                    })
            })
            .collect()
    }
}
pub fn require(p: &Principal, privilege: &str, target: Target<'_>) -> Result<()> {
    ensure!(p.allows(privilege, target), "forbidden");
    Ok(())
}
pub fn hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
pub fn new_token() -> String {
    let mut b = [0; 32];
    rand::rng().fill_bytes(&mut b);
    format!(
        "stn_{}",
        b.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
pub async fn bootstrap(pool: &SqlitePool, token: &str) -> Result<()> {
    let mut tx = pool.begin().await?;
    // Fixed IDs and INSERT OR IGNORE keep revocation, disabling and rotation across restarts.
    sqlx::query("INSERT OR IGNORE INTO users(id,name,created_at) VALUES('admin','admin',?)")
        .bind(store::now())
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT OR IGNORE INTO roles(id,name,is_admin) VALUES('admin','admin',1)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT OR IGNORE INTO user_roles(user_id,role_id) VALUES('admin','admin')")
        .execute(&mut *tx)
        .await?;
    let inserted=sqlx::query("INSERT OR IGNORE INTO api_tokens(id,user_id,name,token_hash,created_at) VALUES('bootstrap','admin','Bootstrap',?,?)").bind(hash(token)).bind(store::now()).execute(&mut *tx).await?;
    if inserted.rows_affected() != 0 {
        store::audit_as(&mut tx, "access.bootstrapped", "admin", "", Some("admin")).await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn principal(pool: &SqlitePool, user_id: &str) -> Result<Principal> {
    let r = sqlx::query("SELECT * FROM users WHERE id=? AND disabled=0")
        .bind(user_id)
        .fetch_one(pool)
        .await?;
    let user = User {
        id: r.get("id"),
        name: r.get("name"),
        disabled: r.get("disabled"),
        created_at: r.get("created_at"),
    };
    let roles=sqlx::query("SELECT r.* FROM roles r JOIN user_roles u ON u.role_id=r.id WHERE u.user_id=? ORDER BY r.id").bind(user_id).fetch_all(pool).await?.iter().map(|r|Role{id:r.get("id"),name:r.get("name"),is_admin:r.get("is_admin")}).collect();
    let grants=sqlx::query("SELECT g.* FROM grants g JOIN user_roles u ON u.role_id=g.role_id WHERE u.user_id=? ORDER BY g.id").bind(user_id).fetch_all(pool).await?.iter().map(|r|Grant{id:r.get("id"),role_id:r.get("role_id"),target_kind:r.get("target_kind"),target_id:r.get("target_id"),privilege:r.get("privilege")}).collect();
    Ok(Principal {
        user,
        roles,
        grants,
    })
}
pub async fn authenticate(pool: &SqlitePool, token: &str) -> Result<Principal> {
    ensure!(!token.is_empty(), "invalid token");
    authenticate_hash(pool, &hash(token)).await
}
pub async fn authenticate_hash(pool: &SqlitePool, token_hash: &str) -> Result<Principal> {
    let r=sqlx::query("SELECT t.id,t.user_id FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND u.disabled=0 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)").bind(token_hash).bind(store::now()).fetch_one(pool).await?;
    sqlx::query("UPDATE api_tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<=?)").bind(store::now()).bind(r.get::<&str,_>("id")).bind(store::now()-60).execute(pool).await?;
    principal(pool, r.get("user_id")).await
}
pub async fn as_role(pool: &SqlitePool, actor: &Principal, id: &str) -> Result<Principal> {
    ensure!(actor.admin(), "forbidden");
    let r = sqlx::query("SELECT * FROM roles WHERE id=?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    let grants = sqlx::query("SELECT * FROM grants WHERE role_id=?")
        .bind(id)
        .fetch_all(pool)
        .await?
        .iter()
        .map(|g| Grant {
            id: g.get("id"),
            role_id: g.get("role_id"),
            target_kind: g.get("target_kind"),
            target_id: g.get("target_id"),
            privilege: g.get("privilege"),
        })
        .collect();
    Ok(Principal {
        user: actor.user.clone(),
        roles: vec![Role {
            id: r.get("id"),
            name: r.get("name"),
            is_admin: r.get("is_admin"),
        }],
        grants,
    })
}
