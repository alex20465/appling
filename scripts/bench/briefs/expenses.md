Model expense claims in a company with several departments.

An employee writes a claim with lines; each line has a date, a category, an amount and a receipt. A claim is a draft until the employee submits it; a claim without lines cannot be submitted. A submitted claim is approved or rejected with a reason. The employee's manager approves claims up to 1000 in total; larger claims need finance. An approved claim is paid through the company's bank, which can decline the payment; a declined payment sends the claim back to finance.

Employees see only their own claims, managers those of their department, finance all of them. Claims of one company are never visible to another company. Finance reaches the open claims through an API for its accounting system.
