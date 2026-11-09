grammar Appling

entry Model:
    modules+=Module*;

// Cross cutting

Module:
    'module' name=Ident relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{'
        (exports+=Export | members+=Member)*
    '}';

Export:
    'export' names+=[Member:Ident] (',' names+=[Member:Ident])*;

Member:
    Module | Role | Actor | Tenant
    | Enum | ValueType | Entity
    | Event | Action | Machine | Job
    | Query | Projection | External | UseCase
    | Interface
    | Page | Navigation | Flow | Messages
    | Migration;

// The condition says when an actor counts as the role; it reads only actor, tenant and now.
Role:
    'role' name=Ident relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? ('{' condition=Expr '}')?;

// `is` binds the actor to the entity that stores it, such as the user.
Actor:
    'actor' kind=('human' | 'system' | 'service') name=Ident ('is' entity=[Entity:QualifiedName])?
    ('roles' roles+=[Role:QualifiedName] (',' roles+=[Role:QualifiedName])*)? relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))?
    ('{' fields+=Field* '}')?;

Tenant:
    'tenant' name=Ident 'on' entity=[Entity:QualifiedName] relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))?;

// `('does' does=(TEXT_BLOCK | STRING))?` describes in plain text what a named element is or does; `@Name`
// inside names an element (appling-does.ts). It follows the head (name, signature, relevance) and comes
// before the body, at the end without one. Kept inline in every rule so `set` finds its keyword.

// How much a declaration matters to what the application does; a module's level applies to its members.
Relevance returns string:
    'core' | 'supporting' | 'peripheral';

// L1 Domain

Enum:
    'enum' name=Ident relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{' literals+=EnumLiteral* '}';

EnumLiteral:
    name=Ident ('does' does=(TEXT_BLOCK | STRING))?;

ValueType:
    'value' name=Ident relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{' fields+=Field* '}';

Entity:
    'entity' link?='link'? name=Ident relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{'
        (fields+=Field | invariants+=Invariant | policies+=Policy)*
    '}';

Field:
    name=Ident ':' type=TypeRef modifiers+=FieldModifier*
    ('default' default=Expr)? ('=' derived=Expr)? ('does' does=(TEXT_BLOCK | STRING))?;

FieldModifier returns string:
    'unique' | 'state' | 'owned';

TypeRef:
    (primitive=PrimitiveType | decl=[TypeDecl:QualifiedName]) (many?='[' ']')? (optional?='?')?;

PrimitiveType returns string:
    'String' | 'Text' | 'Int' | 'Decimal' | 'Bool' | 'Date' | 'DateTime' | 'Duration' | 'Money' | 'File' | 'Uuid';

type TypeDecl = Enum | ValueType | Entity;

Invariant:
    'invariant' label=STRING '{' condition=Expr '}';

Policy:
    'policy' (operations+=Operation (',' operations+=Operation)*)?
    ('fields' fields+=[Field:Ident] (',' fields+=[Field:Ident])*)?
    '{' condition=Expr '}';

Operation returns string:
    'read' | 'create' | 'update' | 'delete';

// L2 Behavior

Event:
    'event' name=Ident relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{' fields+=Field* '}';

Action:
    'action' name=Ident ('on' entity=[Entity:QualifiedName])? relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{'
        ('input' '{' inputs+=Param* '}')?
        preconditions+=Precondition*
        ('effect' '{' effects+=Effect* '}')?
        ('errors' errors+=ErrorDecl (',' errors+=ErrorDecl)*)?
        ('consistency' consistency=('atomic' | 'eventual'))?
        policies+=Policy*
    '}';

Param:
    name=Ident ':' type=TypeRef ('does' does=(TEXT_BLOCK | STRING))?;

ErrorDecl:
    name=Ident ('does' does=(TEXT_BLOCK | STRING))?;

Precondition:
    'requires' '{' condition=Expr '}' ('else' error=[ErrorDecl:Ident])?;

Effect:
    SetEffect | CreateEffect | EmitEffect;

SetEffect:
    'set' field=[Field:Ident] '=' value=Expr;

CreateEffect:
    'create' entity=[Entity:QualifiedName] '{' (assignments+=Assignment (',' assignments+=Assignment)*)? '}';

EmitEffect:
    'emit' event=[Event:QualifiedName] ('{' (assignments+=Assignment (',' assignments+=Assignment)*)? '}')?;

Assignment:
    name=Ident '=' value=Expr;

Machine:
    'machine' name=Ident 'on' field=[Field:QualifiedName] relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{' transitions+=Transition* '}';

Transition:
    'transition' from+=Ident (',' from+=Ident)* '->' to=Ident
    ('via' action=[Action:QualifiedName] | 'on' event=[Event:QualifiedName])
    ('when' '{' guard=Expr '}')?
    ('effect' '{' effects+=Effect* '}')?;

Job:
    'job' name=Ident ('every' schedule=STRING | 'on' event=[Event:QualifiedName])
    'run' action=[Action:QualifiedName] ('where' '{' filter=Expr '}')? relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))?;

// L3 Application

Query:
    'query' name=Ident 'from' entity=[Entity:QualifiedName] relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{'
        ('input' '{' inputs+=Param* '}')?
        ('where' '{' filter=Expr '}')?
        ('sort' sorts+=Sort (',' sorts+=Sort)*)?
        ('paginate' pageSize=NUMBER)?
        policies+=Policy*
    '}';

Sort:
    field=[Field:Ident] direction=('asc' | 'desc')?;

Projection:
    'projection' name=Ident 'from' source=[ProjectionSource:QualifiedName] relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{'
        fields+=ProjectionField*
    '}';

type ProjectionSource = Entity | Query;

ProjectionField:
    name=Ident ('=' value=Expr)? ('does' does=(TEXT_BLOCK | STRING))?;

External:
    'external' name=Ident relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{' (operations+=ExternalOperation | keys+=ExternalKey)* '}';

// What the vendor behind an external needs: a typed setting or secret, never its value.
ExternalKey:
    kind=('setting' | 'secret') name=Ident ':' type=TypeRef ('does' does=(TEXT_BLOCK | STRING))?;

ExternalOperation:
    'op' name=Ident '(' (params+=Param (',' params+=Param)*)? ')'
    ('returns' returns=TypeRef)?
    ('errors' errors+=ErrorDecl (',' errors+=ErrorDecl)*)?
    ('does' does=(TEXT_BLOCK | STRING))?;

UseCase:
    'usecase' name=Ident ('(' (params+=Param (',' params+=Param)*)? ')')? relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{'
        (steps+=Step | policies+=Policy)*
    '}';

Step:
    CallStep | AwaitStep;

CallStep:
    'step' call=Call handlers+=Handler*;

Handler:
    'on' error=[ErrorDecl:Ident] 'do' call=Call;

AwaitStep:
    'await' event=[Event:QualifiedName] ('timeout' timeout=STRING 'do' call=Call)?;

Call:
    target=[Callable:QualifiedName] '(' (args+=Expr (',' args+=Expr)*)? ')';

type Callable = Action | Query | UseCase | ExternalOperation;

// L4 Interfaces

Interface:
    'interface' protocol=Ident name=Ident ('from' source=[External:QualifiedName])? relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{'
        ('auth' auth=Ident ('from' authBy=[External:QualifiedName])?)?
        ('limit' rateLimit=NUMBER 'per' rateUnit=('second' | 'minute' | 'hour'))?
        ('cors' origins+=STRING (',' origins+=STRING)*)?
        endpoints+=Endpoint*
    '}';

Endpoint:
    verb=Ident path=STRING '->' target=[Exposable:QualifiedName]
    ('as' projection=[Projection:QualifiedName] ('{' picks+=[ProjectionField:Ident] (',' picks+=[ProjectionField:Ident])* '}')?)?;

type Exposable = Query | Action | UseCase;

// L5 Experience

Page:
    'page' name=Ident 'route' route=STRING relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{' components+=Component* '}';

Component:
    ListView | DetailView | FormView;

ListView:
    'list' query=[Query:QualifiedName]
    'as' projection=[Projection:QualifiedName] ('{' picks+=[ProjectionField:Ident] (',' picks+=[ProjectionField:Ident])* '}')?
    ('actions' actions+=[Action:QualifiedName] (',' actions+=[Action:QualifiedName])*)?;

DetailView:
    'detail' projection=[Projection:QualifiedName]
    ('{' picks+=[ProjectionField:Ident] (',' picks+=[ProjectionField:Ident])* '}')?
    ('actions' actions+=[Action:QualifiedName] (',' actions+=[Action:QualifiedName])*)?;

FormView:
    'form' submits=[Submittable:QualifiedName];

type Submittable = Action | UseCase;

Navigation:
    'navigation' name=Ident relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{' items+=NavItem* '}';

NavItem:
    label=STRING '->' page=[Page:QualifiedName] ('{' children+=NavItem* '}')?;

Flow:
    'flow' name=Ident 'for' usecase=[UseCase:QualifiedName] relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))?
    '{' pages+=[Page:QualifiedName] ('->' pages+=[Page:QualifiedName])* '}';

Messages:
    'messages' name=Ident relevance=Relevance? ('does' does=(TEXT_BLOCK | STRING))? '{' entries+=Message* '}';

Message:
    key=QualifiedName '=' text=STRING;

// Evolution

Migration:
    'migration' name=Ident ('does' does=(TEXT_BLOCK | STRING))? '{' steps+=MigrationStep* '}';

// Targets are paths inside the migration's module, as they were before the step.
MigrationStep:
    {infer RenameStep} 'rename' target=QualifiedName '->' newName=Ident
    | {infer RetypeStep} 'retype' target=QualifiedName ':' oldType=TypeRef '->' newType=TypeRef
    | {infer RemoveStep} 'remove' target=QualifiedName;

// Expressions: a CEL subset

Expr:
    OrExpr;

OrExpr infers Expr:
    AndExpr ({infer BinaryExpr.left=current} op='||' right=AndExpr)*;

AndExpr infers Expr:
    RelExpr ({infer BinaryExpr.left=current} op='&&' right=RelExpr)*;

RelExpr infers Expr:
    AddExpr ({infer BinaryExpr.left=current} op=('==' | '!=' | '<=' | '>=' | '<' | '>' | 'in') right=AddExpr)?;

AddExpr infers Expr:
    MulExpr ({infer BinaryExpr.left=current} op=('+' | '-') right=MulExpr)*;

MulExpr infers Expr:
    PrefixExpr ({infer BinaryExpr.left=current} op=('*' | '/' | '%') right=PrefixExpr)*;

PrefixExpr infers Expr:
    {infer UnaryExpr} op=('!' | '-') operand=PrefixExpr
    | PostfixExpr;

PostfixExpr infers Expr:
    PrimaryExpr (
        {infer MemberExpr.receiver=current} '.' member=Ident (call?='(' (args+=Expr (',' args+=Expr)*)? ')')?
        | {infer IndexExpr.receiver=current} '[' index=Expr ']'
    )*;

PrimaryExpr infers Expr:
    '(' Expr ')'
    | {infer ListExpr} '[' (items+=Expr (',' items+=Expr)*)? ']'
    | {infer StringExpr} value=STRING
    | {infer NumberExpr} value=NUMBER
    | {infer BoolExpr} value=('true' | 'false')
    | {infer NullExpr} 'null'
    | {infer NameExpr} name=Ident (call?='(' (args+=Expr (',' args+=Expr)*)? ')')?;

// Names

QualifiedName returns string:
    Ident ('.' Ident)*;

// Keywords that are also valid names, so fields like `state` or `order` stay legal.
Ident returns string:
    ID | 'state' | 'input' | 'value' | 'from' | 'to' | 'on' | 'for' | 'step' | 'list' | 'detail'
    | 'form' | 'route' | 'run' | 'actions' | 'fields' | 'role' | 'event' | 'action' | 'query'
    | 'page' | 'timeout' | 'sort' | 'when' | 'create' | 'read' | 'update' | 'delete' | 'per'
    | 'flow' | 'actor' | 'tenant' | 'set' | 'op' | 'human' | 'system' | 'service' | 'asc'
    | 'desc' | 'remove' | 'rename' | 'retype' | 'roles' | 'second' | 'minute' | 'hour' | 'link'
    | 'core' | 'supporting' | 'peripheral' | 'default' | 'limit' | 'messages' | 'migration' | 'is' | 'does'
    | 'setting' | 'secret';

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w]*/;
terminal NUMBER returns number: /[0-9]+(\.[0-9]+)?/;
// A text block: raw lines between triple quotes, common indentation stripped. Listed before STRING so `"""` is not read as `""`.
terminal TEXT_BLOCK: /"""[\s\S]*?"""/;
terminal STRING: /"(\\.|[^"\\])*"/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
