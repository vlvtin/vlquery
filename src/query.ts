import { DbSet } from "./set";
import { Queryable } from "./queryable";
import { Entity } from "./entity";
import { QueryProxy } from "./query-proxy";
import { DbClient } from "./client";
import { ForeignReference } from "./reference";
import { queryFunctions, QueryFunction } from "./functions";

export class Query<TModel extends Entity<TQueryModel>, TQueryModel extends QueryProxy> implements Queryable<TModel, TQueryModel> {
	public limitRows = -1;
	public skipRows = -1;
	public joins: QueryJoin<TModel, TQueryModel>[] = [];
	public conditions: QueryFragment<TModel, TQueryModel>[] = [];
	public rootExtent: QueryExtent<TModel, TQueryModel>;
	public parameters: QueryParameter<TModel, TQueryModel>[] = [];
	public extentIndex = 0;

	static defaultPageSize = 100;
	
	constructor(public set: DbSet<TModel, TQueryModel>, preConditions?: CompiledQuery[]) {
		this.rootExtent = new QueryExtent(this);

		if (preConditions) {
			for (let condition of preConditions) {
				this.where(condition as unknown as (item: TQueryModel) => any);
			}
		}
	}

	where(query: (item: TQueryModel) => any): Queryable<TModel, TQueryModel> {
		// ensure compiled query
		if (typeof query == "function") {
			throw new Error("Uncompiled query cannot be used in runtime");
		}

		this.conditions.push(new QueryFragment(this, query as CompiledQuery));

		return this;
	}

	async first(query?: (item: TQueryModel) => any): Promise<TModel> {
		if (query) {
			this.where(query);
		}

		this.limit(1);

		return (await this.toArray())[0];
	}

	async single(query?: (item: TQueryModel) => any): Promise<TModel> {
		const res = await this.first(query);

		if (!res) {
			throw new Error("Single query returned zero items");
		}

		return res;
	}

	private async toArrayRaw(): Promise<any[]> {
		const sql = this.toSQL();

		console.log(
			"SQL " + "-".repeat(30 - 4), 
			sql.replace(/\$[0-9]+/g, match => `<${this.parameters[+match.replace("$", "") - 1].value}>`), 
			"-".repeat(30)
		);

		return await DbClient.query(sql, this.parameters.map(p => p.value));
	}

	async toArray(): Promise<TModel[]> {
		return (await this.toArrayRaw()).map(raw => this.set.constructObject(raw));
	}

	include(selector: (item: TQueryModel) => any): Queryable<TModel, TQueryModel> {
		throw new Error("Method not implemented.");
	}

	count: Promise<number>;

	orderByAscending(sorter: (item: TQueryModel) => any): Queryable<TModel, TQueryModel> {
		throw new Error("Method not implemented.");
	}

	orderByDescending(sorter: (item: TQueryModel) => any): Queryable<TModel, TQueryModel> {
		throw new Error("Method not implemented.");
	}

	skip(count: number): Queryable<TModel, TQueryModel> {
		this.skipRows = count;

		return this;
	}

	limit(count: number): Queryable<TModel, TQueryModel> {
		this.limitRows = count;

		return this;
	}

	page(index: number, size?: number): Queryable<TModel, TQueryModel> {
		size = size || Query.defaultPageSize;

		return this.limit(size).skip(index * size);
	}

	toSQL() {
		return `
		
			SELECT ${this.rootExtent.name}.*
			FROM ${this.set.$meta.tableName} AS ${this.rootExtent.name}
			${this.joins.map(j => j.toSQL()).join("\n")}
			${this.conditions.length ? `WHERE ${this.conditions.map(c => c.toSQL()).join(" AND ")}` : ""}
		
		`;
	}
}

class QueryJoin<TModel extends Entity<TQueryModel>, TQueryModel extends QueryProxy> {
	extent: QueryExtent<TModel, TQueryModel>;
	
	constructor(
		public query: Query<TModel, TQueryModel>,
		public from: QueryExtent<TModel, TQueryModel>,
		public table: string,
		public column: string
	) {
		this.extent = new QueryExtent(query);

		this.query.joins.push(this);
	}

	toSQL() {
		return `INNER JOIN ${this.table} AS ${this.extent.name} ON ${this.from.name}.${this.column} = ${this.extent.name}.id`;
	}
}

export class QueryFragment<TModel extends Entity<TQueryModel>, TQueryModel extends QueryProxy> {
	compare?: {
		left: QueryFragment<TModel, TQueryModel>;
		right: QueryFragment<TModel, TQueryModel>;
		operator: string;
	}

	logical?: {
		left: QueryFragment<TModel, TQueryModel>;
		right: QueryFragment<TModel, TQueryModel>;
		operator: string;
	}

	path: {
		column: string;
		extent: QueryExtent<TModel, TQueryModel>;
		part?: string;
	};

	call: {
		parameters: QueryFragment<TModel, TQueryModel>[];
		to: QueryFunction;
		source: QueryFragment<TModel, TQueryModel>;
	}

	valueParameter: QueryParameter<TModel, TQueryModel>;
	
	constructor(
		public query: Query<TModel, TQueryModel>,
		tree: CompiledQuery
	) {
		if (tree.compare) {
			this.compare = {
				left: new QueryFragment<TModel, TQueryModel>(
					query, 
					tree.compare.left
				),
				right: new QueryFragment<TModel, TQueryModel>(
					query, 
					tree.compare.right
				),
				operator: tree.compare.operator
			};
		}

		if (tree.logical) {
			this.logical = {
				left: new QueryFragment<TModel, TQueryModel>(
					query, 
					tree.logical.left
				),
				right: new QueryFragment<TModel, TQueryModel>(
					query, 
					tree.logical.right
				),
				operator: tree.logical.operator
			};
		}

		if (tree.value) {
			this.valueParameter = new QueryParameter(query, tree.value);
		}

		if (tree.call) {
			const func = queryFunctions[tree.call.to[tree.call.to.length - 1]];

			this.call = {
				to: func,
				parameters: tree.call.parameters.map(p => new QueryFragment<TModel, TQueryModel>(query, p)),
				source: new QueryFragment<TModel, TQueryModel>(query, {
					path: tree.call.to.slice(0, tree.call.to.length - 1)
				})
			}
		}

		if (tree.path) {
			let set = this.query.set as DbSet<Entity<QueryProxy>, QueryProxy>;
			let extent = this.query.rootExtent;

			for (let i = 0; i < tree.path.length; i++) {
				const name = tree.path[i];
				const component = set.$meta.columns[name];
				const proxy = new set.modelConstructor();

				if (component) {
					// simple attribute
					this.path = {
						column: component.name,
						extent
					};
				} else if (proxy[name]) {
					// references
					const reference = proxy[name] as ForeignReference<Entity<QueryProxy>>;

					const join = new QueryJoin(
						query, 
						extent, 
						(new reference.$relation()).$meta.tableName, 
						reference.$column
					);

					extent = join.extent;
					set = new reference.$relation().$meta.set;
				} else {
					this.path.part = name;
				}
			}
		}
	}

	toSQL() {
		if (this.compare) {
			if (this.compare.left === null) {
				if (this.compare.operator == "=") {
					return `${this.compare.right.toSQL()} IS NULL`;
				}

				if (this.compare.operator == "!=") {
					return `${this.compare.right.toSQL()} IS NOT NULL`;
				}
			}

			if (this.compare.right === null) {
				if (this.compare.operator == "=") {
					return `${this.compare.left.toSQL()} IS NULL`;
				}

				if (this.compare.operator == "!=") {
					return `${this.compare.left.toSQL()} IS NOT NULL`;
				}
			}

			return `(${
				this.compare.left.toSQL()
			} ${this.compare.operator} ${
				this.compare.right.toSQL()
			})`;
		}

		if (this.logical) {
			return `(${
				this.logical.left.toSQL()
			} ${this.logical.operator} ${
				this.logical.right.toSQL()
			})`;
		}

		if (this.call) {
			return `(${this.call.to.toSQL(this)})`;
		}

		if (this.valueParameter) {;
			return this.valueParameter.name;
		}

		if (this.path) {
			if (this.path.part) {
				const part = {
					year: "YEAR",
					month: "MONTH",
					date: "DAY",
					hour: "HOUR",
					minute: "MINUTE",
					second: "SECOND",
					milisecond: "MILLISECONDS",
					week: "WEEK",
					dayOfWeek: "DOW",
					microseconds: "MICROSECONDS"
				}[this.path.part];

				if (!part) {
					return new Error(`Invalid column part '${this.path.part}' in column '${this.path.column}'`);
				}

				return `EXTRACT(${part} FROM ${this.path.extent.name}.${this.path.column})`;
			}

			return `${this.path.extent.name}.${this.path.column}`;
		}
	}
}

class QueryExtent<TModel extends Entity<TQueryModel>, TQueryModel extends QueryProxy> {
	name: string;
	
	constructor(
		public query: Query<TModel, TQueryModel>
	) {
		this.name = `ext${query.extentIndex++}`;
	}
}

class QueryParameter<TModel extends Entity<TQueryModel>, TQueryModel extends QueryProxy> {
	name: string;
	
	constructor(
		public query: Query<TModel, TQueryModel>,
		public value: any
	) {
		query.parameters.push(this);

		this.name = `$${query.parameters.length}`;
	}
}

interface CompiledQuery {
	compare?: {
		left: CompiledQuery;
		right: CompiledQuery;
		operator: "=" | "!=" | "<" | ">" | "<=" | ">=";
	};

	logical?: {
		left: CompiledQuery;
		right: CompiledQuery;
		operator: "and" | "or";
	};

	path?: string[];

	call?: {
		to: string[];
		parameters: CompiledQuery[];
	};

	value?: any;
}