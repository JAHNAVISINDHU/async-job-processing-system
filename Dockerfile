FROM node:18-alpine

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . ./

RUN mkdir -p /usr/src/app/output

EXPOSE 3000

CMD ["npm", "run", "start"]
